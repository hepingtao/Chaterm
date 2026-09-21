// Desktop adapter for the shared SFTP file-management core (src/shared/sftp).
//
// The core owns all transfer/list/ops logic and is Electron-free so the CLI can
// reuse it. This file keeps everything Electron/desktop-specific:
//   - IPC handler registration (channel names and payload shapes unchanged)
//   - progress forwarding to the renderer webContents
//   - connection lifecycle: pools, reuse, JumpServer bastion flows, reconnects
//   - the JumpServer HOME probe/debug machinery
import { ipcMain, app } from 'electron'
import path from 'node:path'
import fs from 'fs'
import nodeFs from 'node:fs/promises'
import type { Client } from 'ssh2'
import { Client as SSHClient } from 'ssh2'
import { getSftpConnection, pickReconnectConnectionInfo } from './sshHandle'
import { getSshKeepaliveConfig } from './sshConfig'
import {
  connectionStatus,
  sftpConnections,
  sshConnections,
  sshConnectionPool,
  KeyboardInteractiveTimeout,
  handleRequestKeyboardInteractive
} from './sshHandle'
import { jumpserverConnections, createJumpServerExecStream, executeCommandOnJumpServerExec } from './jumpserverHandle'
import { getConnectionPoolKey, createProxyCommandSocket } from './sshHandle'
import { createProxySocket } from './proxy'
import { getAlgorithmsByAssetType } from './algorithms'
import { getPackageInfo } from './jumpserver/connectionManager'
import {
  cancelActiveTask,
  chmodRemote,
  copyOrMoveBySftp as copyOrMoveBySftpCore,
  deleteRemote,
  directoryDownload,
  directoryUpload,
  ensureAbsLocalPath,
  formatSftpList,
  getSftpHostLabel,
  isDirEntry,
  isLocalId,
  listLocalDir,
  readSftpDirWithFallback as coreReadSftpDirWithFallback,
  renameRemote,
  sftpMkdirSafe,
  sftpStatWithTimeout,
  sftpReaddirWithTimeout,
  setSftpDebug,
  streamTransfer,
  toPosix,
  transferDirR2R as transferDirR2RCore,
  transferFileR2R as transferFileR2RCore
} from '../../shared/sftp'
import type { ChildTaskOptions, R2RDirArgs, R2RFileArgs, SftpConnectResult, SftpOpsDeps, TransferResult } from '../../shared/sftp'

const sftpLogger = createLogger('ssh')

// Debug logger for HOME-resolution investigation. Writes to a standalone file
// so it can be inspected without filtering through the full app log.
const HOME_DEBUG_LOG = path.join(app.getPath('home'), '.chaterm-home-debug.log')
const homeDebug = (message: string, data?: any) => {
  try {
    const d = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`
    const line = `${local} ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`
    fs.appendFileSync(HOME_DEBUG_LOG, line)
  } catch {}
}

// The shared core reports debug info through this sink so both hosts log
// through their own channel.
setSftpDebug(homeDebug)

// SFTP-owned connection state (created by this module, not the terminal flows).
// Tracks JumpServer connections created by SFTP itself, not by the SSH connect flow.
export const sftpOwnedJumpServerConnections = new Map<string, Client>()
// Stores shell streams opened only to bootstrap SFTP-owned JumpServer sessions.
const sftpOwnedJumpServerStreams = new Map<string, any>()

export const sftpConnectionInfoMap = new Map<string, any>()

// Remote HOME directory per SFTP connection id, probed via sftp.realpath('.').
// Falls back to '/' when the HOME path cannot be resolved.
export const sftpHomeMap = new Map<string, string>()

// Connection ids whose current SFTP handle browses the JumpServer bastion
// virtual filesystem (created on the bastion SSH connection), as opposed to
// a compound-username connection that reaches the target asset directly.
export const virtualFsSftpIds = new Set<string>()

const sendProgress = (event: any, payload: any) => {
  const wc = event?.sender
  if (!wc || wc.isDestroyed?.()) {
    sftpLogger.warn('Progress event skipped: webContents missing or destroyed', {
      event: 'ssh.sftp.progress.skipped',
      taskKey: payload?.taskKey
    })
    return
  }
  try {
    wc.send('ssh:sftp:transfer-progress', payload)
  } catch (err) {
    sftpLogger.error('Failed to send SFTP transfer progress event', {
      event: 'ssh.sftp.progress.send_failed',
      taskKey: payload?.taskKey,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

// Bind the Electron-free core to this renderer event: connection lookups go to
// the desktop pools, progress goes to the requesting webContents.
const makeCtx = (event: any): SftpOpsDeps => ({
  getSftp: (id: string) => getSftpConnection(id),
  getHostLabel: (id: string, sftp?: any) => getSftpHostLabel(id, sftp),
  emit: (payload: Record<string, any>) => sendProgress(event, payload),
  tempDir: app.getPath('temp'),
  resolveSshConn: (id: string) => findSshConnForSftp(id),
  createJumpServerExec: (terminalId: string) => createJumpServerExecStream(terminalId),
  execCommandOnJumpServer: (stream: any, cmd: string) => executeCommandOnJumpServerExec(stream, cmd)
})

const listDeps = {
  resolveSshConn: (id: string) => findSshConnForSftp(id),
  createJumpServerExec: (terminalId: string) => createJumpServerExecStream(terminalId),
  execCommandOnJumpServer: (stream: any, cmd: string) => executeCommandOnJumpServerExec(stream, cmd)
}

// Legacy positional wrapper over the core listing (renderer contract unchanged).
export const readSftpDirWithFallback = async (
  sftp: any,
  reqPath: string,
  id: string,
  includeHidden = false,
  label = 'readdir result'
): Promise<any[]> => coreReadSftpDirWithFallback(sftp, reqPath, { id, includeHidden, label, deps: listDeps })

// (event, ...) wrappers keep the historical exported signatures used by the
// handlers and by other modules; the logic itself lives in the shared core.
export async function handleStreamTransfer(
  event: any,
  id: string,
  srcPath: string,
  destPath: string,
  type: 'download' | 'upload',
  isInternalCall = false,
  childOpts?: ChildTaskOptions
): Promise<TransferResult> {
  return streamTransfer(makeCtx(event), id, srcPath, destPath, type, isInternalCall, childOpts)
}

export async function handleDirectoryDownload(event: any, id: string, remoteDir: string, localDir: string): Promise<TransferResult> {
  return directoryDownload(makeCtx(event), id, remoteDir, localDir)
}

export async function handleDirectoryTransfer(event: any, id: string, localDir: string, remoteDir: string): Promise<TransferResult> {
  return directoryUpload(makeCtx(event), id, localDir, remoteDir)
}

export async function transferFileR2R(event: any, args: R2RFileArgs & ChildTaskOptions): Promise<TransferResult> {
  return transferFileR2RCore(makeCtx(event), args)
}

export async function transferDirR2R(event: any, args: R2RDirArgs): Promise<TransferResult> {
  return transferDirR2RCore(makeCtx(event), args)
}

// ssh2 keeps socket state on the client instance, so this is the cheapest health signal we can read.
const isClientSocketAlive = (conn?: Client) => {
  const client = conn as any
  if (!client) return false

  const sock = client._sock
  if (!sock) return true

  return !sock.destroyed && !sock.closed
}

const isJumpServerId = (id: string) => id.includes(':local:') || id.includes('local-team')

// Find the underlying SSH client for an SFTP session. JumpServer compound-username
// SFTP connections are stored separately from normal SSH connections because they
// connect directly to the target asset via the JumpServer SFTP port (2222).
export const findSshConnForSftp = (id: string): Client | undefined => {
  if (!id) return undefined

  if (isJumpServerId(id)) {
    const direct = sftpOwnedJumpServerConnections.get(id)
    if (direct && isClientSocketAlive(direct)) return direct

    const prefix = id.substring(0, id.lastIndexOf(':') + 1)
    for (const [existingId, existingConn] of sftpOwnedJumpServerConnections.entries()) {
      const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
      if (existingId.startsWith(prefix) && sessionPart.startsWith('files-') && isClientSocketAlive(existingConn)) {
        return existingConn
      }
    }
    for (const [existingId, existingConn] of sftpOwnedJumpServerConnections.entries()) {
      if (existingId.startsWith(prefix) && isClientSocketAlive(existingConn)) return existingConn
    }
  }

  const direct = sshConnections.get(id)
  if (direct && isClientSocketAlive(direct)) return direct

  const prefix = id.substring(0, id.lastIndexOf(':') + 1)
  for (const [existingId, existingConn] of sshConnections.entries()) {
    const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
    if (existingId.startsWith(prefix) && sessionPart.startsWith('files-') && isClientSocketAlive(existingConn)) {
      return existingConn
    }
  }
  for (const [existingId, existingConn] of sshConnections.entries()) {
    if (existingId.startsWith(prefix) && isClientSocketAlive(existingConn)) return existingConn
  }

  return undefined
}
// Reuse reconnect info across sibling file sessions that share the same prefix.
const getReusableSftpConnectionInfo = (id: string) => {
  const direct = sftpConnectionInfoMap.get(id)
  if (direct) return direct

  if (!id) return null

  const prefix = id.substring(0, id.lastIndexOf(':') + 1)

  for (const [existingId, info] of sftpConnectionInfoMap.entries()) {
    const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
    if (existingId.startsWith(prefix) && sessionPart.startsWith('files-')) {
      return info
    }
  }

  for (const [existingId, info] of sftpConnectionInfoMap.entries()) {
    if (existingId.startsWith(prefix)) {
      return info
    }
  }

  return null
}

// Derive system name from bastion domain (e.g., jump.itouchtv.cn -> itouchtv)
// If bastion is stored as IP, fall back to hardcoded 'itouchtv'.
const deriveSystemNameFromHost = (host: string): string => {
  if (!host) return 'itouchtv'
  const parts = String(host).split('.')
  // Check if it's an IP address (all numeric parts)
  const isIP = parts.length === 4 && parts.every((p) => /^\d+$/.test(p))
  if (isIP) return 'itouchtv'
  if (parts.length < 2) return 'itouchtv'
  // Take the second-level domain (e.g., itouchtv from jump.itouchtv.cn)
  return parts[parts.length - 2]
}

// Enrich cached connection info with sftpCompoundUsername for JumpServer sessions
// that were established via SSH terminal (not through the Files asset path).
// Compound username format: <user>@<system_name>@<asset_ip>
const enrichJumpServerConnInfo = (info: any, sid: string): any => {
  if (!info) return info
  // Only enrich JumpServer connections missing compound username
  if (info.sftpCompoundUsername) return info
  if (info.sshType !== 'jumpserver') return info
  // Check if session ID looks like a JumpServer session (:local: or :local-team:)
  if (!sid.includes(':local:') && !sid.includes(':local-team:')) return info

  const bastionHost = info.host
  const username = info.username
  const targetIp = info.targetIp

  if (bastionHost && username && targetIp) {
    const systemName = deriveSystemNameFromHost(bastionHost)
    if (systemName) {
      const compound = `${username}@${systemName}@${targetIp}`
      homeDebug('[enrichJumpServerConnInfo] constructed compound username', {
        sid,
        compound
      })
      return {
        ...info,
        sftpCompoundUsername: compound,
        sftpPort: info.sftpPort || 2222
      }
    }
  }
  return info
}

// In-flight ensureSftpReady reconnects per session id, to deduplicate
// concurrent reconnect attempts for the same connection.
const inflightSftpReady = new Map<string, Promise<any>>()

const ensureSftpReady = async (event: any, id: string): Promise<any> => {
  const sid = String(id || '')
  if (!sid) {
    throw new Error('missing connection id')
  }

  let sftp = getSftpConnection(sid)

  if (sftp) {
    try {
      await sftpStatWithTimeout(sftp, '.', 3000)
      return sftp
    } catch {
      // Drop only the current SFTP handle and rebuild it from cached connect info.
      await closeSftpOnly(sid)
    }
  }

  // Deduplicate concurrent reconnects for the same session (e.g. get-home and
  // a parallel directory listing) so only one compound connection is created.
  const inflight = inflightSftpReady.get(sid)
  if (inflight) {
    homeDebug('[ensureSftpReady] joining in-flight reconnect', { sid })
    await inflight
    sftp = getSftpConnection(sid)
    if (sftp) return sftp
    throw new Error('SFTP reconnect failed')
  }

  const rawCachedInfo = getReusableSftpConnectionInfo(sid)
  if (!rawCachedInfo) {
    throw new Error('missing reconnect connection info')
  }

  // Enrich JumpServer sessions with compound username so SFTP reconnects
  // directly to the target asset instead of the bastion virtual filesystem.
  const cachedInfo = enrichJumpServerConnInfo(rawCachedInfo, sid)

  const connectPromise = connectSftpReuseFirst(event, cachedInfo)
  inflightSftpReady.set(sid, connectPromise)
  let result
  try {
    result = await connectPromise
  } finally {
    inflightSftpReady.delete(sid)
  }

  if (result?.status !== 'connected') {
    throw new Error(result?.message || 'SFTP reconnect failed')
  }

  sftp = getSftpConnection(sid)
  if (!sftp) {
    throw new Error('SFTP reconnect failed: no sftp instance')
  }

  return sftp
}
export const initSftpOnConnection = (
  conn: Client,
  connectionId: string,
  homeHint?: { assetPath?: string; username?: string; directAssetMode?: boolean }
): Promise<void> => {
  return new Promise<void>((resolve) => {
    try {
      conn.sftp((err, sftp) => {
        if (err || !sftp) {
          connectionStatus.set(connectionId, {
            sftpAvailable: false,
            sftpError: err?.message || 'SFTP object is empty'
          })
          sftpConnections.set(connectionId, {
            isSuccess: false,
            error: `sftp init error: "${err?.message || 'SFTP object is empty'}"`
          })
          return resolve()
        }

        // Probe the session with a cheap read to avoid caching a dead SFTP wrapper.
        sftp.readdir('.', (readDirErr) => {
          if (readDirErr) {
            connectionStatus.set(connectionId, {
              sftpAvailable: false,
              sftpError: readDirErr.message
            })
            try {
              sftp.end()
            } catch {}
            sftpConnections.set(connectionId, {
              isSuccess: false,
              error: `sftp readdir error: "${readDirErr.message}"`
            })
            resolve()
          } else {
            sftpConnections.set(connectionId, { isSuccess: true, sftp })
            connectionStatus.set(connectionId, { sftpAvailable: true })

            // JumpServer bastion mode: when a homeHint is provided (asset title
            // path + username), validate "<assetPath>/home/<username>" with readdir
            // and use it as HOME. readdir is more reliable than realpath on
            // JumpServer's virtual SFTP filesystem.
            // directAssetMode: compound username connects to the target asset's real
            // filesystem. realpath('.') returns the HOME of the JumpServer login user,
            // which may differ from the desired HOME (e.g., /home/operation-alert vs
            // /home/itouchtv). Prefer /home/itouchtv if it exists.
            if (homeHint?.directAssetMode) {
              const preferredHome = '/home/itouchtv'
              sftpReaddirWithTimeout(sftp, preferredHome, 5000)
                .then(() => {
                  sftpHomeMap.set(connectionId, preferredHome)
                  homeDebug('[initSftp] directAssetMode preferred home', { connectionId, home: preferredHome })
                  resolve()
                })
                .catch(() => {
                  sftp.realpath('.', (rpErr, absPath) => {
                    const home = !rpErr && absPath ? absPath : '/'
                    sftpHomeMap.set(connectionId, home)
                    homeDebug('[initSftp] directAssetMode realpath fallback', { connectionId, home })
                    resolve()
                  })
                })
              return
            }
            const hintAssetPath = homeHint?.assetPath?.trim()
            const hintUsername = homeHint?.username?.trim()
            if (hintAssetPath && hintUsername) {
              const candidate = `${hintAssetPath}/home/${hintUsername}`
              homeDebug('[initSftp] homeHint validate', { connectionId, candidate })
              sftpReaddirWithTimeout(sftp, candidate, 5000)
                .then(() => {
                  sftpHomeMap.set(connectionId, candidate)
                  homeDebug('[initSftp] homeHint SUCCESS', { connectionId, home: candidate })
                  resolve()
                })
                .catch((e: any) => {
                  homeDebug('[initSftp] homeHint FAILED, trying /home/<username>', {
                    connectionId,
                    candidate,
                    error: e?.message || String(e)
                  })
                  // The homeHint path (assetTitlePath) doesn't exist — this happens
                  // when SFTP connects directly to the target asset's real filesystem
                  // (via compound username or JumpServer SFTP proxy). Try the standard
                  // Linux HOME path /home/<username> synchronously before falling back.
                  const directHome = `/home/${hintUsername}`
                  sftpReaddirWithTimeout(sftp, directHome, 5000)
                    .then(() => {
                      sftpHomeMap.set(connectionId, directHome)
                      homeDebug('[initSftp] /home/<username> SUCCESS', { connectionId, home: directHome })
                      resolve()
                    })
                    .catch((e2: any) => {
                      homeDebug('[initSftp] /home/<username> FAILED, trying /home/itouchtv', {
                        connectionId,
                        error: e2?.message || String(e2)
                      })
                      // Try hardcoded /home/itouchtv (standard account on all assets)
                      // before falling back to root. This handles cases where the
                      // JumpServer login user differs from the desired HOME user.
                      const preferredHome = '/home/itouchtv'
                      sftpReaddirWithTimeout(sftp, preferredHome, 5000)
                        .then(() => {
                          sftpHomeMap.set(connectionId, preferredHome)
                          homeDebug('[initSftp] /home/itouchtv SUCCESS', { connectionId, home: preferredHome })
                          resolve()
                        })
                        .catch(() => {
                          // Fallback: use '/' and kick off async probe (realpath is
                          // unreliable on JumpServer virtual FS and may never callback).
                          sftpHomeMap.set(connectionId, '/')
                          homeDebug('[initSftp] all HOME attempts FAILED, fallback to /', { connectionId })
                          resolve()
                          probeAssetHomeAsync(sftp, '/', hintUsername, connectionId)
                        })
                    })
                })
            } else {
              // No hint.
              const isJumpServer = (connectionId.includes('local-team') || connectionId.includes(':local:')) && connectionId.includes('@')
              if (isJumpServer) {
                // JumpServer virtual FS: realpath('.') may never callback, so set
                // HOME to '/' immediately and async-probe for asset HOME.
                sftpHomeMap.set(connectionId, '/')
                homeDebug('[initSftp] jumpserver set / and async probe', { connectionId })
                resolve()
                const user = connectionId.split('@')[0]
                // Decode hostname from connectionId: user@ip:orgType:hostnameBase64:session
                let hostHint: string | undefined
                const parts = connectionId.split(':')
                if (parts.length >= 3) {
                  try {
                    hostHint = Buffer.from(parts[2], 'base64').toString('utf-8') || undefined
                  } catch {}
                }
                if (user) {
                  sftpReaddirWithTimeout(sftp, '/', 5000)
                    .then(() => probeAssetHomeAsync(sftp, '/', user, connectionId, hostHint))
                    .catch(() => homeDebug('[initSftp] root readdir failed', { connectionId }))
                }
              } else {
                // Normal SSH: realpath('.') reliably returns HOME.
                sftp.realpath('.', (rpErr, absPath) => {
                  const home = !rpErr && absPath ? absPath : '/'
                  sftpHomeMap.set(connectionId, home)
                  homeDebug('[initSftp] realpath set', { connectionId, home })
                  resolve()
                })
              }
            }
          }
        })
      })
    } catch (err: any) {
      connectionStatus.set(connectionId, {
        sftpAvailable: false,
        sftpError: err?.message || String(err)
      })
      sftpConnections.set(connectionId, {
        isSuccess: false,
        error: `sftp init error: "${err?.message || String(err)}"`
      })
      resolve()
    }
  })
}
// Build a homeHint from connectionInfo so initSftpOnConnection can probe the
// JumpServer virtual asset HOME path. Returns undefined when no hint is available.
const buildHomeHint = (connectionInfo: any): { assetPath?: string; username?: string } | undefined => {
  const assetPath = connectionInfo?.remoteHomePath?.trim()
  const username = connectionInfo?.username?.trim()
  if (assetPath && username) return { assetPath, username }
  return undefined
}

// Tracks connection IDs that currently have an active async HOME probe running,
// to prevent duplicate concurrent probes from causing SFTP contention.
const activeHomeProbes = new Set<string>()

// Async (non-blocking) JumpServer asset HOME probe. Searches the virtual SFTP
// filesystem for a "home/<username>" directory. Updates sftpHomeMap on success.
// Each readdir has a timeout; the whole probe is bounded and never rejects.
// hostHint (asset hostname) is used to prioritize matching subdirs for speed.
const probeAssetHomeAsync = (sftp: any, root: string, username: string, connectionId: string, hostHint?: string) => {
  // Prevent duplicate concurrent probes for the same connection.
  if (activeHomeProbes.has(connectionId)) {
    homeDebug('[probeAsync] already in progress, skipping', { connectionId })
    return
  }
  activeHomeProbes.add(connectionId)

  const joinPath = (base: string, name: string) => (base.endsWith('/') ? `${base}${name}` : `${base}/${name}`)
  const hint = hostHint?.toLowerCase().trim()

  // Fast path: try common bastion virtual FS patterns directly.
  // This avoids slow recursive search when we know the path structure.
  const tryFastPaths = async (): Promise<string | null> => {
    if (!hostHint) return null
    const candidates = [
      `/触电研发中心/生产环境/大数据/${hostHint}/home/itouchtv`,
      `/触电研发中心/测试环境/大数据/${hostHint}/home/itouchtv`,
      `/触电研发中心/生产环境/大数据/${hostHint}/测试linux普通-账号模版/home/itouchtv`,
      `/触电研发中心/测试环境/大数据/${hostHint}/测试linux普通-账号模版/home/itouchtv`,
      `/${hostHint}/home/itouchtv`,
      `/${hostHint}/测试linux普通-账号模版/home/itouchtv`
    ]
    for (const p of candidates) {
      try {
        await sftpReaddirWithTimeout(sftp, p, 3000)
        homeDebug('[probeAsync] fast path hit', { connectionId, path: p })
        return p
      } catch {}
    }
    return null
  }

  const search = async (dir: string, depth: number, inHintSubtree: boolean): Promise<string | null> => {
    if (depth > 6) return null
    let entries: any[]
    try {
      entries = await sftpReaddirWithTimeout(sftp, dir, 5000)
    } catch {
      return null
    }

    if (inHintSubtree || !hint) {
      const homeEntry = entries.find((e) => e.filename === 'home' && isDirEntry(e))
      if (homeEntry) {
        const homePath = joinPath(dir, 'home')
        homeDebug('[probeAsync] found home dir', { connectionId, homePath, inHintSubtree, dir })
        try {
          const homeEntries = await sftpReaddirWithTimeout(sftp, homePath, 4000)
          const userEntry = homeEntries.find((e) => e.filename === username && e.filename !== '.' && e.filename !== '..')
          if (userEntry) return joinPath(homePath, userEntry.filename)
          const anyUser = homeEntries.find((e) => e.filename !== '.' && e.filename !== '..' && isDirEntry(e))
          if (anyUser) return joinPath(homePath, anyUser.filename)
        } catch (e: any) {
          homeDebug('[probeAsync] home readdir failed', { connectionId, homePath, error: e?.message })
        }
      }
    }

    const subdirs = entries.filter((e) => e.filename !== '.' && e.filename !== '..' && e.filename !== 'home' && isDirEntry(e))
    subdirs.sort((a, b) => {
      const aM = hint ? (a.filename.toLowerCase().includes(hint) ? 0 : 1) : 0
      const bM = hint ? (b.filename.toLowerCase().includes(hint) ? 0 : 1) : 0
      if (aM !== bM) return aM - bM
      const aAdmin = a.filename.includes('超管') ? 1 : 0
      const bAdmin = b.filename.includes('超管') ? 1 : 0
      return aAdmin - bAdmin
    })

    for (const entry of subdirs) {
      const childPath = joinPath(dir, entry.filename)
      const childInHint = inHintSubtree || (hint ? entry.filename.toLowerCase().includes(hint) : false)
      const found = await search(childPath, depth + 1, childInHint)
      if (found) return found
    }
    return null
  }

  homeDebug('[probeAsync] start', { connectionId, root, username, hostHint, hint })
  ;(async () => {
    // Try fast paths first
    const fast = await tryFastPaths()
    if (fast) return fast
    // Fall back to recursive search
    return await search(root, 0, false)
  })()
    .then((result) => {
      if (result) {
        // The SFTP handle may have been swapped (e.g. upgraded from the bastion
        // virtual FS to a compound-username direct connection) while this probe
        // was running — discard the stale result in that case.
        const currentSftp = (sftpConnections.get(connectionId) as any)?.sftp
        if (currentSftp && currentSftp !== sftp) {
          homeDebug('[probeAsync] handle replaced during probe, discarding result', { connectionId, result })
          return
        }
        sftpHomeMap.set(connectionId, result)
        homeDebug('[probeAsync] SUCCESS', { connectionId, home: result })
      } else {
        homeDebug('[probeAsync] not found', { connectionId, root, username, hostHint })
      }
    })
    .catch((e: any) => {
      homeDebug('[probeAsync] error', { connectionId, error: e?.message || String(e) })
    })
    .finally(() => {
      activeHomeProbes.delete(connectionId)
    })
}
const isSkippedConn = (conn: Client | undefined, skipped?: Client) => {
  return !!conn && !!skipped && conn === skipped
}

// Prefer an existing SSH connection when it is still alive and not explicitly skipped.
const findReusableSftpConn = (connectionInfo: any, skippedConn?: Client): Client | undefined => {
  const { id } = connectionInfo

  const direct = sshConnections.get(id)
  if (direct && !isSkippedConn(direct, skippedConn) && isClientSocketAlive(direct)) return direct

  if (id) {
    const prefix = id.substring(0, id.lastIndexOf(':') + 1)

    for (const [existingId, existingConn] of sshConnections.entries()) {
      const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
      if (
        existingId.startsWith(prefix) &&
        sessionPart.startsWith('files-') &&
        !isSkippedConn(existingConn, skippedConn) &&
        isClientSocketAlive(existingConn)
      ) {
        return existingConn
      }
    }

    for (const [existingId, existingConn] of sshConnections.entries()) {
      if (existingId.startsWith(prefix) && !isSkippedConn(existingConn, skippedConn) && isClientSocketAlive(existingConn)) return existingConn
    }
  }

  return undefined
}

// JumpServer reuse is read-only here: dead connect-side records are ignored, not deleted.
const findReusableJumpServerConn = (connectionInfo: any, skippedConn?: Client): Client | undefined => {
  const { id, assetUuid } = connectionInfo
  const jumpserverUuid = assetUuid || id

  for (const [, existingData] of jumpserverConnections.entries()) {
    if (existingData.jumpserverUuid !== jumpserverUuid || !existingData.conn) continue

    if (!isSkippedConn(existingData.conn, skippedConn) && isClientSocketAlive(existingData.conn)) {
      return existingData.conn
    }
  }

  return undefined
}

// Re-initialize the bastion virtual-FS SFTP handle on the still-alive terminal
// JumpServer connection. Used as a fallback when the compound-username direct
// connection to the target asset cannot be established.
const restoreVirtualFsSftp = async (sid: string, info: any) => {
  const reusable = info ? findReusableJumpServerConn(info) : undefined
  if (reusable) {
    await initSftpOnConnection(reusable, sid, buildHomeHint(info))
    if (getSftpConnection(sid)) {
      virtualFsSftpIds.add(sid)
      homeDebug('[restoreVirtualFsSftp] restored bastion virtual FS handle', { sid })
      return
    }
  }
  homeDebug('[restoreVirtualFsSftp] no reusable bastion connection', { sid })
}

// Reuse priority: active SFTP/SSH session first, then JumpServer/shared pooled SSH connection.
const findReusableConn = (connectionInfo: any, skippedConn?: Client): Client | undefined => {
  const { sshType, host, port, username } = connectionInfo

  const reusableSftpConn = findReusableSftpConn(connectionInfo, skippedConn)
  if (reusableSftpConn) return reusableSftpConn

  if (sshType === 'jumpserver') {
    const reusableJumpServerConn = findReusableJumpServerConn(connectionInfo, skippedConn)
    if (reusableJumpServerConn) return reusableJumpServerConn
  }

  if (host && username) {
    const poolKey = getConnectionPoolKey(host, port || 22, username)
    const pooled = sshConnectionPool.get(poolKey)
    if (pooled?.conn && !isSkippedConn(pooled.conn, skippedConn) && isClientSocketAlive(pooled.conn)) return pooled.conn
  }

  return undefined
}

export const connectSftpReuseFirst = async (event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const { id } = connectionInfo
  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)

  markPending(id, requestId)
  // When sftpCompoundUsername is available, skip reusing JumpServer SSH connections
  // (which only access the bastion's virtual FS). We need a fresh connection to the
  // JumpServer SFTP port (2222) with the compound username to reach the target asset.
  const reused = connectionInfo?.sftpCompoundUsername ? undefined : findReusableConn(connectionInfo, options?.skipReusableConn)
  homeDebug('[connectSftpReuseFirst] entry', {
    id,
    hasReused: !!reused,
    sshType: connectionInfo?.sshType,
    sftpCompoundUsername: !!connectionInfo?.sftpCompoundUsername,
    targetIp: connectionInfo?.targetIp
  })

  if (reused) {
    try {
      homeDebug('[connectSftpReuseFirst] init on reused conn', { id })
      await initSftpOnConnection(reused, id, buildHomeHint(connectionInfo))

      const p = getPending(id)
      if (p?.cancelled) {
        await closeSftpOnly(id)
        clearPending(id)
        return { status: 'cancelled', message: 'cancelled' }
      }

      const st = connectionStatus.get(id) as any
      if (st?.sftpAvailable) {
        clearPending(id)
        if (connectionInfo?.sshType === 'jumpserver') virtualFsSftpIds.add(id)
        return { status: 'connected', message: 'SFTP ready (reused existing SSH connection)' }
      }

      // Mark the reused SFTP as unavailable and fall back to a fresh connection below.
      sftpConnections.delete(id)
      connectionStatus.set(id, {
        sftpAvailable: false,
        sftpError: st?.sftpError || 'reused ssh not available'
      })
    } catch (e) {
      // Reuse failed; keep connect-side state untouched and create a new SFTP connection instead.
      sftpConnections.delete(id)
      connectionStatus.set(id, {
        sftpAvailable: false,
        sftpError: (e as Error)?.message || 'reused ssh not available'
      })
    }
  }

  clearPending(id)
  return await connectSftpNew(event, connectionInfo, { skipReusableConn: reused })
}
// Keep SFTP state in sync when the underlying transport closes unexpectedly.
const markSftpDead = async (id: string, reason = 'SFTP connection lost') => {
  const sid = String(id || '')
  if (!sid) return

  try {
    const rec = sftpConnections.get(sid) as any
    if (rec?.sftp) {
      try {
        rec.sftp.end()
      } catch {}
    }
  } catch {}

  sftpConnections.delete(sid)
  virtualFsSftpIds.delete(sid)
  connectionStatus.set(sid, {
    sftpAvailable: false,
    sftpError: reason
  })
}

export const connectSftpNew = async (event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const { id, sshType } = connectionInfo

  if (sshType === 'jumpserver') {
    return await connectJumpServerSftpNew(event, connectionInfo, options)
  }

  const conn = new SSHClient()
  const { host, port, username, password, privateKey, passphrase, needProxy, proxyConfig, proxyCommand, connIdentToken, asset_type } = connectionInfo

  const packageInfo = getPackageInfo()
  const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
  const ident = `${packageInfo.name}_${packageInfo.version}${identToken}`
  const algorithms = getAlgorithmsByAssetType(asset_type)
  const keepaliveCfg = await getSshKeepaliveConfig()

  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
  markPending(id, requestId, conn as any)

  // This path creates an SFTP-owned SSH connection when reuse is not possible.
  const connectConfig: any = {
    host,
    port: port || 22,
    username,
    keepaliveInterval: keepaliveCfg.keepaliveInterval,
    keepaliveCountMax: keepaliveCfg.keepaliveCountMax,
    readyTimeout: KeyboardInteractiveTimeout,
    tryKeyboard: true,
    ident,
    algorithms
  }

  if (privateKey) {
    connectConfig.privateKey = privateKey
    if (passphrase) connectConfig.passphrase = passphrase
  } else if (password) {
    connectConfig.password = password
  } else {
    clearPending(id)
    return { status: 'error', message: 'No valid authentication method provided' }
  }

  try {
    if (proxyCommand) {
      connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, port || 22)
      delete connectConfig.host
      delete connectConfig.port
    } else if (needProxy) {
      connectConfig.sock = await createProxySocket(proxyConfig, host, port || 22)
    }
  } catch (err: any) {
    clearPending(id)
    return { status: 'error', message: `Failed to establish a transport layer tunnel: ${err?.message || String(err)}` }
  }

  return new Promise((resolve) => {
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      ;(async () => {
        try {
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }
          await handleRequestKeyboardInteractive(event, id, prompts, finish, host)
        } catch (e: any) {
          conn.end()
          clearPending(id)
          resolve({ status: 'error', message: e?.message || String(e) })
        }
      })()
    })

    conn.on('ready', () => {
      ;(async () => {
        sshConnections.set(id, conn)
        try {
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            clearPending(id)
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }

          await initSftpOnConnection(conn as any, id, buildHomeHint(connectionInfo))

          const p2 = getPending(id)
          if (p2?.cancelled) {
            await closeSftpOnly(id)
            conn.end()
            clearPending(id)
            return resolve({ status: 'cancelled', message: 'cancelled' })
          }

          clearPending(id)
          const st = connectionStatus.get(id) as any
          resolve(
            st?.sftpAvailable
              ? { status: 'connected', message: 'SFTP ready (new SFTP-only SSH connection)' }
              : { status: 'error', message: st?.sftpError || 'SFTP init failed' }
          )
        } catch (e: any) {
          clearPending(id)
          resolve({ status: 'error', message: e?.message || String(e) })
        }
      })()
    })

    conn.on('error', (err: any) => {
      const p = getPending(id)
      if (p?.cancelled) {
        clearPending(id)
        return resolve({ status: 'cancelled', message: 'cancelled' })
      }
      clearPending(id)
      resolve({ status: 'error', message: `SFTP connection failed: ${err.message}` })
    })

    conn.on('close', async () => {
      await markSftpDead(id, 'SFTP connection closed')
    })

    conn.on('end', async () => {
      await markSftpDead(id, 'SFTP connection ended')
    })
    conn.connect(connectConfig)
  })
}

function openShell(conn: any, connectionInfo: any) {
  return new Promise((resolve, reject) => {
    conn.shell({ term: connectionInfo.terminalType || 'xterm-256color' }, (err, stream) => {
      if (err) return reject(err)
      resolve(stream)
    })
  })
}
const connectJumpServerSftpNew = async (_event: any, connectionInfo: any, options?: { skipReusableConn?: Client }): Promise<SftpConnectResult> => {
  const {
    id,
    host,
    port,
    username,
    password,
    privateKey,
    passphrase,
    needProxy,
    proxyConfig,
    proxyCommand,
    connIdentToken,
    asset_type,
    targetIp,
    sftpCompoundUsername,
    sftpPort
  } = connectionInfo

  homeDebug('[connectJumpServerSftpNew] entry', { id, hasCompound: !!sftpCompoundUsername, targetIp, host, username })

  // If we have sftpCompoundUsername from pickReconnectConnectionInfo, use it to directly access target asset
  if (sftpCompoundUsername && targetIp) {
    homeDebug('[connectJumpServerSftpNew] using compound username path', { id, sftpCompoundUsername, targetIp })
    sftpLogger.info('JumpServer SFTP using sftpCompoundUsername for direct asset access', {
      event: 'sftp.jumpserver.compound.username',
      connectionId: id,
      sftpCompoundUsername,
      targetIp
    })

    const conn = new SSHClient()
    const packageInfo = getPackageInfo()
    const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
    const ident = `${packageInfo.name}_${packageInfo.version}${identToken}`
    const algorithms = getAlgorithmsByAssetType(asset_type)
    const keepaliveCfg = await getSshKeepaliveConfig()
    const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
    markPending(id, requestId, conn as any)

    const connectConfig: any = {
      host,
      port: sftpPort || 2222,
      username: sftpCompoundUsername,
      keepaliveInterval: keepaliveCfg.keepaliveInterval,
      keepaliveCountMax: keepaliveCfg.keepaliveCountMax,
      readyTimeout: 180000,
      tryKeyboard: true,
      ident,
      algorithms
    }

    if (privateKey) {
      try {
        connectConfig.privateKey = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey)
        if (passphrase) connectConfig.passphrase = passphrase
      } catch (err: any) {
        clearPending(id)
        return { status: 'error', message: `Private key format error: ${err?.message || String(err)}` }
      }
    } else if (password) {
      connectConfig.password = password
    } else {
      clearPending(id)
      return { status: 'error', message: 'Missing authentication info: private key or password required' }
    }

    try {
      const sftpTargetPort = sftpPort || 2222
      if (proxyCommand) {
        connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, sftpTargetPort)
        delete connectConfig.host
        delete connectConfig.port
      } else if (needProxy) {
        connectConfig.sock = await createProxySocket(proxyConfig, host, sftpTargetPort)
      }
    } catch (err: any) {
      clearPending(id)
      return { status: 'error', message: `Failed to establish a transport layer tunnel: ${err?.message || String(err)}` }
    }

    return new Promise((resolve) => {
      let settled = false
      const safeResolve = (data) => {
        if (settled) return
        settled = true
        resolve(data)
      }
      const cleanup = async () => {
        sftpOwnedJumpServerConnections.delete(id)
        sftpOwnedJumpServerStreams.delete(id)
        await markSftpDead(id, 'cleanup')
      }

      conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
        ;(async () => {
          try {
            const p = getPending(id)
            if (p?.cancelled) {
              conn.end()
              return safeResolve({ status: 'cancelled', message: 'cancelled' })
            }
            await handleRequestKeyboardInteractive(_event, id, prompts, finish, host)
          } catch (e: any) {
            conn.end()
            clearPending(id)
            safeResolve({ status: 'error', message: e?.message || String(e) })
          }
        })()
      })

      conn.on('ready', async () => {
        sftpOwnedJumpServerConnections.set(id, conn)
        try {
          // Compound username connects directly to the target asset's real filesystem,
          // so use realpath('.') to find HOME (like normal SSH), not the virtual FS logic.
          await initSftpOnConnection(conn, id, { directAssetMode: true })
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            clearPending(id)
            return safeResolve({ status: 'cancelled', message: 'cancelled' })
          }
          clearPending(id)
          const st = connectionStatus.get(id) as any
          if (st?.sftpAvailable) {
            virtualFsSftpIds.delete(id)
            safeResolve({ status: 'connected', message: 'SFTP ready (JumpServer compound username - target asset)' })
          } else {
            cleanup()
            safeResolve({ status: 'error', message: st?.sftpError || 'SFTP init failed' })
          }
        } catch (e: any) {
          cleanup()
          safeResolve({ status: 'error', message: e?.message || String(e) })
        }
      })

      conn.on('error', (err: any) => {
        sftpLogger.error('SFTP compound username connection error', { event: 'sftp.connect.error', error: err?.message || String(err) })
        cleanup()
        clearPending(id)
        safeResolve({ status: 'error', message: err?.message || 'Connection failed' })
      })

      conn.on('close', () => {
        cleanup()
      })

      conn.connect(connectConfig)
    })
  }

  // No sftpCompoundUsername available - fall back to using reusable JumpServer connection
  // This will only give access to the bastion filesystem
  const reusableConn = findReusableJumpServerConn(connectionInfo, options?.skipReusableConn)
  homeDebug('[connectJumpServerSftpNew] fallback path', { id, hasReusableJump: !!reusableConn })
  if (reusableConn) {
    const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
    markPending(id, requestId)
    homeDebug('[connectJumpServerSftpNew] init on reusable JumpServer conn', { id })
    await initSftpOnConnection(reusableConn, id, buildHomeHint(connectionInfo))

    const p = getPending(id)
    if (p?.cancelled) {
      await closeSftpOnly(id)
      clearPending(id)
      return { status: 'cancelled', message: 'cancelled' }
    }

    clearPending(id)
    const st = connectionStatus.get(id) as any
    if (st?.sftpAvailable) {
      virtualFsSftpIds.add(id)
      homeDebug('[connectJumpServerSftpNew] reusable JumpServer conn SUCCESS', { id })
      return { status: 'connected', message: 'SFTP ready (reused JumpServer connection - bastion filesystem)' }
    }
  }

  homeDebug('[connectJumpServerSftpNew] creating NEW SSH connection to JumpServer bastion', { id, host, username, readyTimeout: 180000 })

  const conn = new SSHClient()

  const packageInfo = getPackageInfo()
  const identToken = connIdentToken ? `_t=${connIdentToken}` : ''
  const ident = `${packageInfo.name}_${packageInfo.version}${identToken}`
  const algorithms = getAlgorithmsByAssetType(asset_type)
  const keepaliveCfg = await getSshKeepaliveConfig()

  const requestId = String(connectionInfo?.sftpRequestId || `${Date.now()}_${Math.random().toString(16).slice(2)}`)
  markPending(id, requestId, conn as any)

  const connectConfig: any = {
    host,
    port: port || 22,
    username,
    keepaliveInterval: keepaliveCfg.keepaliveInterval,
    keepaliveCountMax: keepaliveCfg.keepaliveCountMax,
    readyTimeout: 180000,
    tryKeyboard: true,
    ident,
    algorithms
  }

  if (privateKey) {
    try {
      connectConfig.privateKey = Buffer.isBuffer(privateKey) ? privateKey : Buffer.from(privateKey)
      if (passphrase) connectConfig.passphrase = passphrase
    } catch (err: any) {
      clearPending(id)
      return { status: 'error', message: `Private key format error: ${err?.message || String(err)}` }
    }
  } else if (password) {
    connectConfig.password = password
  } else {
    clearPending(id)
    return { status: 'error', message: 'Missing authentication info: private key or password required' }
  }

  try {
    if (proxyCommand) {
      connectConfig.sock = await createProxyCommandSocket(proxyCommand, host, port || 22)
      delete connectConfig.host
      delete connectConfig.port
    } else if (needProxy) {
      connectConfig.sock = await createProxySocket(proxyConfig, host, port || 22)
    }
  } catch (err: any) {
    clearPending(id)
    return { status: 'error', message: `Failed to establish a transport layer tunnel: ${err?.message || String(err)}` }
  }

  return new Promise((resolve) => {
    let settled = false

    const safeResolve = (data) => {
      if (settled) return
      settled = true
      resolve(data)
    }

    // Clean only the JumpServer resources created by SFTP itself.
    const cleanupJumpServerSftpOnlySession = async (reason: string) => {
      sftpOwnedJumpServerConnections.delete(id)
      sftpOwnedJumpServerStreams.delete(id)
      await markSftpDead(id, reason)
    }

    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      ;(async () => {
        try {
          homeDebug('[connectJumpServerSftpNew] keyboard-interactive', { id })
          const p = getPending(id)
          if (p?.cancelled) {
            conn.end()
            return safeResolve({ status: 'cancelled', message: 'cancelled' })
          }
          await handleRequestKeyboardInteractive(_event, id, prompts, finish, host)
        } catch (e: any) {
          conn.end()
          clearPending(id)
          safeResolve({ status: 'error', message: e?.message || String(e) })
        }
      })()
    })

    conn.on('ready', async () => {
      try {
        homeDebug('[connectJumpServerSftpNew] ready, opening shell', { id })
        const stream = await openShell(conn, connectionInfo)
        // Store SFTP-owned JumpServer resources separately from connect-managed sessions.
        sftpOwnedJumpServerConnections.set(id, conn)
        sftpOwnedJumpServerStreams.set(id, stream)

        await initSftpOnConnection(conn, id, buildHomeHint(connectionInfo))

        clearPending(id)

        const st = connectionStatus.get(id)
        if (st?.sftpAvailable) virtualFsSftpIds.add(id)
        safeResolve(
          st?.sftpAvailable
            ? { status: 'connected', message: 'SFTP ready (new JumpServer connection)' }
            : { status: 'error', message: st?.sftpError || 'SFTP init failed' }
        )
      } catch (e: any) {
        clearPending(id)
        conn.end()
        safeResolve({ status: 'error', message: e?.message || String(e) })
      }
    })

    conn.on('error', (err) => {
      homeDebug('[connectJumpServerSftpNew] error', { id, error: err?.message || String(err) })
      clearPending(id)
      conn.end()
      safeResolve({
        status: 'error',
        message: `JumpServer SFTP connection failed: ${err.message}`
      })
    })

    conn.on('close', async () => {
      await cleanupJumpServerSftpOnlySession('SFTP connection closed')
    })

    conn.on('end', async () => {
      await cleanupJumpServerSftpOnlySession('SFTP connection ended')
    })

    conn.connect(connectConfig)
  })
}

type PendingSftp = {
  requestId: string
  cancelled: boolean
  conn?: Client
}
const pendingSftpConnects = new Map<string, PendingSftp>()

const markPending = (id: string, requestId: string, conn?: Client) => {
  pendingSftpConnects.set(id, { requestId, cancelled: false, conn })
}
const getPending = (id: string) => pendingSftpConnects.get(id)
const clearPending = (id: string) => pendingSftpConnects.delete(id)

// Resolve sibling file-panel ids to the same underlying SFTP record when needed.
const findReusableSftpKey = (id: string) => {
  if (sftpConnections.has(id)) return id

  if (!id) return id

  const prefix = id.substring(0, id.lastIndexOf(':') + 1)

  for (const [existingId] of sftpConnections.entries()) {
    const sessionPart = existingId.substring(existingId.lastIndexOf(':') + 1)
    if (existingId.startsWith(prefix) && sessionPart.startsWith('files-')) {
      return existingId
    }
  }

  for (const [existingId] of sftpConnections.entries()) {
    if (existingId.startsWith(prefix)) {
      return existingId
    }
  }

  return id
}

export const closeSftpOnly = async (connectionId: string): Promise<{ status: string; message: string }> => {
  const id = String(connectionId || '')
  if (!id) return { status: 'error', message: 'missing id' }

  const actualId = findReusableSftpKey(id)

  try {
    const p = pendingSftpConnects.get(actualId)
    if (p) {
      p.cancelled = true
      try {
        p.conn?.end()
      } catch {}
      clearPending(actualId)
    }

    const rec = sftpConnections.get(actualId) as any
    if (rec?.sftp) {
      try {
        rec.sftp.end()
      } catch {}
    }

    sftpConnections.delete(actualId)
    virtualFsSftpIds.delete(actualId)
    connectionStatus.set(actualId, { sftpAvailable: false, sftpError: 'SFTP closed by user' })

    // Only tear down JumpServer resources that were created by SFTP itself.
    const ownedStream = sftpOwnedJumpServerStreams.get(actualId)
    if (ownedStream) {
      try {
        ownedStream.end()
      } catch {}
      sftpOwnedJumpServerStreams.delete(actualId)
    }

    const ownedConn = sftpOwnedJumpServerConnections.get(actualId)
    if (ownedConn) {
      try {
        ownedConn.end()
      } catch {}
      sftpOwnedJumpServerConnections.delete(actualId)
    }

    return { status: 'closed', message: 'SFTP closed' }
  } catch (e: any) {
    return { status: 'error', message: e?.message || String(e) }
  }
}
export const registerFileSystemHandlers = () => {
  ipcMain.handle('ssh:sftp:connect', async (_event, connectionInfo) => {
    homeDebug('[connect] entry', {
      id: connectionInfo?.id,
      remoteHomePath: connectionInfo?.remoteHomePath,
      username: connectionInfo?.username,
      sshType: connectionInfo?.sshType,
      targetIp: connectionInfo?.targetIp
    })
    const result = await connectSftpReuseFirst(_event, connectionInfo)

    // Cache the minimum connection info needed for later SFTP reconnects.
    if (result?.status === 'connected' && connectionInfo?.id) {
      const picked = pickReconnectConnectionInfo(connectionInfo)
      if (picked) {
        sftpConnectionInfoMap.set(String(connectionInfo.id), picked)
        homeDebug('[connect] cached connectionInfo', {
          id: String(connectionInfo.id),
          remoteHomePath: picked.remoteHomePath,
          username: picked.username
        })
      }
    }

    homeDebug('[connect] result', { id: connectionInfo?.id, status: result?.status })

    return result
  })
  ipcMain.handle('ssh:sftp:close', async (_event, payload: { id: string }) => {
    const id = String(payload?.id || '')
    const res = await closeSftpOnly(id)
    sftpConnectionInfoMap.delete(id)
    sftpHomeMap.delete(id)
    return res
  })
  // Reset SFTP handle + HOME cache but preserve cached connection info so
  // ensureSftpReady can reconnect (with enriched compound username).
  ipcMain.handle('ssh:sftp:reset', async (_event, payload: { id: string }) => {
    const id = String(payload?.id || '')
    const res = await closeSftpOnly(id)
    sftpHomeMap.delete(id)
    return res
  })

  ipcMain.handle('ssh:sftp:cancel', async (_event, payload: { id: string; requestId?: string }) => {
    const id = String(payload?.id || '')
    const reqId = String(payload?.requestId || '')
    const p = pendingSftpConnects.get(id)
    if (!p) return { status: 'noop', message: 'no pending connect' }
    if (reqId && p.requestId !== reqId) return { status: 'noop', message: 'requestId mismatch' }

    p.cancelled = true
    try {
      p.conn?.end()
    } catch {}
    return { status: 'cancelled', message: 'cancelled' }
  })
  ipcMain.handle('ssh:sftp:conn:list', async () => {
    return Array.from(sftpConnections.entries()).map(([key, sftpConn]) => ({
      id: key,
      isSuccess: sftpConn.isSuccess,
      error: sftpConn.error
    }))
  })
  ipcMain.handle('app:get-path', async (_e, { name }: { name: 'home' | 'documents' | 'downloads' }) => {
    return app.getPath(name)
  })

  ipcMain.handle('ssh:sftp:debug-log', async (_e, { message, data }: { message: string; data?: any }) => {
    homeDebug(`[renderer] ${message}`, data)
    return true
  })

  ipcMain.handle('ssh:sftp:get-home', async (_e, { id }: { id: string }) => {
    const sid = String(id || '')
    const isJumpServerSid = (sid.includes('local-team') || sid.includes(':local:')) && sid.includes('@')

    // Upgrade path: when the current SFTP handle browses the JumpServer bastion
    // virtual filesystem but cached connection info lets us build a compound
    // username (user@system@target_ip), swap it for a direct connection to the
    // target asset so HOME resolves to the asset's real path (e.g. /home/itouchtv)
    // instead of the bastion tree path (/org/env/.../home/itouchtv).
    if (isJumpServerSid && virtualFsSftpIds.has(sid)) {
      const rawCachedInfo = getReusableSftpConnectionInfo(sid)
      const enriched = enrichJumpServerConnInfo(rawCachedInfo, sid)
      if (enriched?.sftpCompoundUsername) {
        homeDebug('[get-home] upgrading virtual FS handle to compound direct connection', {
          sid,
          compound: enriched.sftpCompoundUsername
        })
        await closeSftpOnly(sid)
        sftpHomeMap.delete(sid)
        try {
          await ensureSftpReady(_e, sid)
          const upgradedHome = sftpHomeMap.get(sid)
          if (upgradedHome && upgradedHome !== '/') {
            homeDebug('[get-home] compound upgrade resolved HOME', { sid, home: upgradedHome })
            return upgradedHome
          }
        } catch (e: any) {
          // Compound direct connection failed — restore the bastion virtual FS
          // handle so the file manager keeps working with bastion-rooted paths.
          homeDebug('[get-home] compound upgrade failed, restoring virtual FS handle', { sid, error: e?.message || String(e) })
          await restoreVirtualFsSftp(sid, rawCachedInfo)
        }
      }
    }

    let current = sftpHomeMap.get(sid) || '/'
    homeDebug('[get-home] return', { sid, current })

    // If not yet resolved to a valid HOME (root or empty) and this is a JumpServer
    // connection, kick off an async probe (non-blocking). Frontend will re-fetch.
    // Accepts both real asset paths (/home/itouchtv) and bastion virtual FS paths
    // (/A100/.../home/itouchtv) as valid — only probe when stuck at root.
    if ((!current || current === '/') && isJumpServerSid) {
      const username = sid.split('@')[0]
      // Decode hostname from connectionId for search prioritization.
      let hostHint: string | undefined
      const parts = sid.split(':')
      if (parts.length >= 3) {
        try {
          hostHint = Buffer.from(parts[2], 'base64').toString('utf-8') || undefined
        } catch {}
      }
      if (username) {
        try {
          let sftp = getSftpConnection(sid)
          if (!sftp) {
            // SFTP handle was reset (e.g., active connection selection).
            // Reconnect with compound username via ensureSftpReady.
            homeDebug('[get-home] no SFTP handle, reconnecting via ensureSftpReady', { sid })
            sftp = await ensureSftpReady(_e, sid)
            // After reconnect, check if HOME was resolved during init
            const newHome = sftpHomeMap.get(sid)
            if (newHome && newHome !== '/') {
              homeDebug('[get-home] compound username reconnect resolved HOME', { sid, home: newHome })
              return newHome
            }
          }
          if (sftp) {
            const root = current !== '/' ? current : '/'
            homeDebug('[get-home] kick async probe', { sid, root, username, hostHint })
            probeAssetHomeAsync(sftp, root, username, sid, hostHint)
          }
        } catch (e: any) {
          homeDebug('[get-home] reconnect/probe failed', { sid, error: e?.message || String(e) })
        }
      }
    }

    return current
  })

  ipcMain.handle('ssh:sftp:list', async (event, { path: reqPath, id, includeHidden }) => {
    if (isLocalId(id)) {
      try {
        return await listLocalDir(reqPath)
      } catch (err: any) {
        return [String(err?.message || err)]
      }
    }

    try {
      // Always probe the current SFTP handle before listing, and reconnect if needed.
      let sftp = await ensureSftpReady(event, id)

      try {
        const list = await coreReadSftpDirWithFallback(sftp, reqPath, {
          id,
          includeHidden: Boolean(includeHidden),
          label: 'readdir result',
          deps: listDeps
        })
        return formatSftpList(list, reqPath)
      } catch {
        // Retry once with a fresh SFTP session if the current handle fails mid-request.
        await closeSftpOnly(String(id))
        sftp = await ensureSftpReady(event, id)

        const list = await coreReadSftpDirWithFallback(sftp, reqPath, {
          id,
          includeHidden: Boolean(includeHidden),
          label: 'readdir result (retry)',
          deps: listDeps
        })
        return formatSftpList(list, reqPath)
      }
    } catch (err: any) {
      const errorCode = err?.code

      switch (errorCode) {
        case 2:
          return [`cannot open directory '${reqPath}': No such file or directory`]
        case 3:
          return [`cannot open directory '${reqPath}': Permission denied`]
        case 4:
          return [`cannot open directory '${reqPath}': Operation failed`]
        case 5:
          return [`cannot open directory '${reqPath}': Bad message format`]
        case 6:
          return [`cannot open directory '${reqPath}': No connection`]
        case 7:
          return [`cannot open directory '${reqPath}': Connection lost`]
        case 8:
          return [`cannot open directory '${reqPath}': Operation not supported`]
        default:
          return [`cannot open directory '${reqPath}': ${err?.message || String(err)}`]
      }
    }
  })
  ipcMain.handle('ssh:sftp:upload-file', (event, args) => handleStreamTransfer(event, args.id, args.localPath, args.remotePath, 'upload'))

  ipcMain.handle('ssh:sftp:upload-directory', (event, args) => handleDirectoryTransfer(event, args.id, args.localPath, args.remotePath))

  ipcMain.handle('ssh:sftp:download-file', (event, args) => handleStreamTransfer(event, args.id, args.remotePath, args.localPath, 'download'))

  ipcMain.handle('ssh:sftp:download-directory', (event, args) => handleDirectoryDownload(event, args.id, args.remoteDir, args.localDir))

  ipcMain.handle('ssh:sftp:delete-file', async (_event, { id, remotePath }) => {
    const sftp = getSftpConnection(id)
    return deleteRemote(sftp, remotePath)
  })

  ipcMain.handle('ssh:sftp:rename-move', async (_e, { id, oldPath, newPath }) => {
    const sftp = getSftpConnection(id)
    return renameRemote(sftp, oldPath, newPath)
  })

  ipcMain.handle('ssh:sftp:mkdir', async (_e, { id, path: dirPath }) => {
    if (isLocalId(id)) {
      try {
        const abs = ensureAbsLocalPath(dirPath)
        await nodeFs.mkdir(abs, { recursive: true })
        return { status: 'success', path: toPosix(abs) }
      } catch (err: any) {
        return { status: 'error', message: String(err?.message || err) }
      }
    }

    const sftp = getSftpConnection(id)
    if (!sftp) return { status: 'error', message: 'Sftp Not connected' }

    try {
      await sftpMkdirSafe(sftp, toPosix(dirPath))
      return { status: 'success', path: toPosix(dirPath) }
    } catch (err: any) {
      return { status: 'error', message: String(err?.message || err) }
    }
  })

  ipcMain.handle('ssh:sftp:chmod', async (_e, { id, remotePath, mode, recursive }) => {
    const sftp = getSftpConnection(id)
    return chmodRemote(sftp, remotePath, mode, recursive)
  })

  ipcMain.handle('ssh:sftp:cancel-task', (_event, { taskKey }) => {
    return cancelActiveTask(taskKey)
  })

  ipcMain.handle('sftp:r2r:file', async (event, args: R2RFileArgs) => {
    return transferFileR2R(event, args)
  })

  ipcMain.handle('sftp:r2r:dir', async (event, args: R2RDirArgs) => {
    return transferDirR2R(event, args)
  })

  ipcMain.handle('ssh:sftp:copy-or-move', async (event, args) => {
    return copyOrMoveBySftpCore(makeCtx(event), args)
  })
}

// Backward-compatible re-exports: these symbols moved to the shared core but
// existing consumers (sshHandle, jumpserver/connectionManager, tests) import
// them from this module.
export {
  formatBackupSuffix,
  backupRemoteEntity,
  wrapSftpAttrs,
  execListDirViaSsh,
  enrichReaddirWithExecFallback,
  shouldSkipUploadEntry
} from '../../shared/sftp'
export type {
  SftpConnectResult,
  TaskStatus,
  ErrorSide,
  TransferStatus,
  TransferResult,
  GroupKind,
  ChildTaskOptions,
  R2RFileArgs,
  R2RDirArgs
} from '../../shared/sftp'
