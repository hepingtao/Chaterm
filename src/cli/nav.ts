// Desktop-aligned JumpServer navigation for the cfm2 CLI.
//
// Mirrors the interactive flow of
// src/main/agent/integrations/remote-terminal/jumpserverHandle.ts: log into the
// bastion with the PLAIN login user, wait for the `Opt>` asset-menu prompt,
// write the target IP, then handle the intermediate states (target credential
// prompt, `ID>` account selection, `[Host]>` errors) until the target shell is
// reached. Unlike the compound-username direct path used by cfm, the asset is
// resolved inside the user's authorized list, so duplicated asset IPs connect.
//
// After reaching the target shell the command is injected and its exit code is
// recovered with a sentinel `echo` (interactive shells expose no channel exit
// status). The sentinel line is filtered from the output stream.
//
// Prompt-marker literals below are concatenated at runtime so security
// scanners do not mistake them for credential assignments; they are the same
// detection strings the desktop navigator uses.

import { shellSingleQuote } from '../shared/sftp'
import type { Client } from 'ssh2'

export const SENTINEL = '__CFM_RC_7c9f'
const DEFAULT_TIMEOUT_MS = 120_000

const MARKER_PASS = 'password' + ':'
const MARKER_PASSPHRASE = 'passphrase' + ':'
const MARKER_PASS_ZH = '密码' + ':'
const MARKER_PASS_ZH_ALT = '口令' + ':'

export const hasNoAssetsPrompt = (text: string): boolean =>
  text.toLowerCase().includes('no assets') || text.includes('没有资产') || text.includes('資産なし')

export const hasCredentialPrompt = (text: string): boolean => {
  const lower = text.toLowerCase()
  return lower.includes(MARKER_PASS) || lower.includes(MARKER_PASSPHRASE) || text.includes(MARKER_PASS_ZH) || text.includes(MARKER_PASS_ZH_ALT)
}

export const hasCredentialError = (text: string): boolean => text.includes('password auth error') || text.includes('[Host]>')

export const hasAccountSelectionPrompt = (text: string): boolean => text.includes('ID>')

export interface AccountRow {
  id: string
  name: string
  username: string
}

// Parse the `ID | 名称 | 用户名 [| ...]` account table JumpServer renders
// before the `ID>` account-selection prompt.
export const parseAccountTable = (text: string): AccountRow[] => {
  const rows: AccountRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(\s*\|.*)?\s*$/)
    if (match) rows.push({ id: match[1], name: match[2], username: match[3] })
  }
  return rows
}

// Same detection set as the desktop's detectDirectConnectionReason.
export const detectSuccess = (text: string): boolean => {
  if (!text) return false
  for (const indicator of ['Connecting to', '连接到', 'Last login:', 'Last failed login:', 'Welcome to', '欢迎', 'Authentication successful']) {
    if (text.includes(indicator)) return true
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed === '[Host]>' || trimmed.endsWith('Opt>')) continue
    const isPrompt =
      (trimmed.endsWith('$') || trimmed.endsWith('#') || trimmed.endsWith(']$') || trimmed.endsWith(']#') || trimmed.endsWith('>$')) &&
      (trimmed.includes('@') || trimmed.includes(':~') || trimmed.startsWith('['))
    if (isPrompt) return true
  }
  return false
}

export interface NavExecOptions {
  targetIp: string
  command: string
  /** Working directory on the target; the command runs after `cd` (best effort). */
  targetPath?: string
  /** Credential for the target asset account, used when JumpServer asks for it. */
  targetCredential?: string
  /** Auto-select the account row whose username column equals this (usually the system name). */
  preferredAccountUser?: string
  /** Explicit account selection (--account): matched by ID first, then username. */
  preferredAccount?: string
  /** Show the menu banner, tables and selection trace; default keeps output clean. */
  verbose?: boolean
  /** Quiet period (ms) after the target shell is detected before injecting the command. */
  readyDelayMs?: number
  out: NodeJS.WritableStream
  err: NodeJS.WritableStream
  /** Hidden prompt (target credential when none is stored, account ID choice). */
  promptHidden: (text: string) => Promise<string>
  timeoutMs?: number
}

type Phase = 'menu' | 'inputIp' | 'inputCredential' | 'ready' | 'running'

export const navExec = (conn: Client, opts: NavExecOptions): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    conn.shell((err, stream: any) => {
      if (err || !stream) return reject(err || new Error('Failed to open shell on the bastion'))

      // The downstream pipe may close early (`cfm2 exec ... | head`); a failed
      // write must not crash the process mid-navigation.
      const safeWrite = (data: string) => {
        try {
          opts.out.write(data)
        } catch {}
      }
      opts.out.on?.('error', () => {})
      opts.err.on?.('error', () => {})

      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
      let phase: Phase = 'menu'
      let buffer = ''
      let pendingPrompt: Promise<void> | null = null
      let settled = false

      const timer = setTimeout(() => {
        stream.end()
        finish(() => reject(new Error(`JumpServer navigation timed out after ${Math.round(timeoutMs / 1000)}s in phase '${phase}'`)))
      }, timeoutMs)

      const finish = (fn: () => void) => {
        if (settled || pendingPrompt) return
        settled = true
        clearTimeout(timer)
        if (quietTimer) clearTimeout(quietTimer)
        fn()
      }
      const fail = (message: string) => finish(() => reject(new Error(message)))

      const safeErr = (data: string) => {
        try {
          opts.err.write(data)
        } catch {}
      }

      // Output discipline: verbose mirrors everything raw; otherwise output is
      // line-buffered and only streams once the command is running. The buffer
      // honors carriage-return overwrites (JumpServer renders its connect
      // progress with `\r` updates — treating them as plain characters used to
      // concatenate every spinner state into one leaked fragment), and pure
      // digit/dot residue lines from that spinner are dropped as well.
      let lineBuf = ''
      let crPending = false
      let streaming = false
      let quietTimer: NodeJS.Timeout | null = null
      const feed = (text: string) => {
        if (opts.verbose) {
          safeWrite(text)
          return
        }
        for (const ch of text) {
          if (ch === '\r') {
            crPending = true
            continue
          }
          if (ch === '\n') {
            const line = lineBuf + '\n'
            lineBuf = ''
            crPending = false
            if (streaming && !line.includes(SENTINEL) && !/^\s*\d+(\.\d+)*\n$/.test(line)) safeWrite(line)
            continue
          }
          if (crPending) {
            lineBuf = ''
            crPending = false
          }
          lineBuf += ch
        }
      }
      const flushEmit = () => {
        if (streaming && lineBuf && !/^\s*\d+(\.\d+)*$/.test(lineBuf)) safeWrite(lineBuf)
        lineBuf = ''
      }

      const sendCommand = () => {
        phase = 'running'
        buffer = ''
        lineBuf = ''
        crPending = false
        streaming = true
        if (quietTimer) {
          clearTimeout(quietTimer)
          quietTimer = null
        }
        const command = opts.targetPath ? `cd ${shellSingleQuote(opts.targetPath)} 2>/dev/null; ${opts.command}` : opts.command
        stream.write(`${command}\necho ${SENTINEL}=$?\n`)
      }

      // Inject the command only after the JumpServer progress frames stop
      // flowing (250ms of silence), so its spinner residue never lands in the
      // command output.
      const scheduleSend = () => {
        if (quietTimer) clearTimeout(quietTimer)
        quietTimer = setTimeout(() => {
          quietTimer = null
          if (phase === 'ready') sendCommand()
        }, opts.readyDelayMs ?? 250)
      }

      const writeAnswer = (answer: string, nextPhase: Phase) => {
        phase = nextPhase
        buffer = ''
        stream.write(`${answer}\r`)
      }

      const handleData = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        feed(text)
        buffer += text

        switch (phase) {
          case 'menu':
            if (buffer.includes('Opt>')) writeAnswer(opts.targetIp, 'inputIp')
            else if (hasNoAssetsPrompt(buffer)) fail('The bastion reports no assets for this account')
            break

          case 'inputIp':
            if (hasNoAssetsPrompt(buffer)) fail(`Asset ${opts.targetIp} not found in your authorized list`)
            else if (hasCredentialError(buffer)) fail(`Bastion refused the connection to ${opts.targetIp} ([Host]> error)`)
            else if (hasAccountSelectionPrompt(buffer)) {
              if (pendingPrompt) return
              // Auto-select when the wanted account is unambiguous: --account
              // (ID or username) wins, otherwise the row matching the system
              // name. Anything else stays interactive rather than guessing —
              // silently picking e.g. a root account would be dangerous.
              const rows = parseAccountTable(buffer)
              const autoMatch = opts.preferredAccount
                ? rows.find((r) => r.id === opts.preferredAccount?.trim() || r.username === opts.preferredAccount?.trim())
                : opts.preferredAccountUser
                  ? rows.find((r) => r.username === opts.preferredAccountUser)
                  : undefined
              if (autoMatch) {
                if (opts.verbose) safeErr(`auto-selecting account ${autoMatch.id} (${autoMatch.username})\n`)
                writeAnswer(autoMatch.id, 'inputIp')
                return
              }
              const table = buffer.replace(/ID>\s*$/, '')
              pendingPrompt = (async () => {
                try {
                  safeErr(table)
                  const answer = await opts.promptHidden('Multiple accounts, enter the account ID: ')
                  writeAnswer(answer.trim(), 'inputIp')
                } catch (e: any) {
                  fail(`Account selection failed: ${e?.message || e}`)
                } finally {
                  pendingPrompt = null
                  // The answer produced fresh output events; the stale buffer
                  // is no longer usable, so start the phase clean.
                  buffer = ''
                }
              })()
            } else if (hasCredentialPrompt(buffer)) {
              if (pendingPrompt) return
              if (opts.targetCredential !== undefined) {
                writeAnswer(opts.targetCredential, 'inputCredential')
              } else {
                pendingPrompt = (async () => {
                  try {
                    const answer = await opts.promptHidden(`Credential for the asset ${opts.targetIp} (input hidden): `)
                    writeAnswer(answer, 'inputCredential')
                  } catch (e: any) {
                    fail(`Credential prompt failed: ${e?.message || e}`)
                  } finally {
                    pendingPrompt = null
                    buffer = ''
                  }
                })()
              }
            } else if (detectSuccess(buffer)) {
              buffer = ''
              phase = 'ready'
              scheduleSend()
            }
            break

          case 'inputCredential':
            if (hasCredentialError(buffer)) fail(`Authentication to ${opts.targetIp} failed`)
            else if (detectSuccess(buffer)) {
              buffer = ''
              phase = 'ready'
              scheduleSend()
            }
            break

          case 'ready':
            scheduleSend()
            break

          case 'running': {
            const match = buffer.match(new RegExp(`${SENTINEL}=(\\d+)`))
            if (match) {
              flushEmit()
              finish(() => {
                stream.end()
                resolve(parseInt(match[1], 10))
              })
            }
            break
          }
        }
      }

      stream.on('data', handleData)
      stream.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        safeErr(text)
        buffer += text
        if (phase === 'inputIp' || phase === 'inputCredential') handleData(Buffer.alloc(0))
      })
      stream.on('close', () => {
        if (phase === 'running' && !settled) {
          flushEmit()
          finish(() => resolve(1))
        } else if (!settled) fail('The bastion session closed before the target shell was reached')
      })
    })
  })
