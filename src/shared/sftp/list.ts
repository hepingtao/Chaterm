// Directory listing with hidden-file recovery strategies, shared by desktop and CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { sftpStatWithTimeout, sftpReaddirWithTimeout, wrapSftpAttrs, withTimeout } from './sftpAsync'
import { shellSingleQuote, toPosix, fmtTime, ensureAbsLocalPath } from './paths'
import { sftpDebug } from './debug'
import type { ListDeps } from './types'

// Common hidden files/directories found in Linux home directories.
// Used as a last-resort probe when exec and JumpServer exec stream are
// unavailable — the SFTP server may filter dot files from readdir but still
// allow stat on individual paths.
const COMMON_HIDDEN_NAMES = [
  '.bashrc',
  '.bash_profile',
  '.bash_history',
  '.bash_logout',
  '.profile',
  '.ssh',
  '.config',
  '.cache',
  '.local',
  '.gitconfig',
  '.vimrc',
  '.viminfo',
  '.env',
  '.npmrc',
  '.nvmrc',
  '.python_history',
  '.wget-hsts',
  '.lesshst',
  '.docker',
  '.gnupg',
  '.pki',
  '.conda',
  '.ipython',
  '.jupyter',
  '.git',
  '.svn',
  '.npm',
  '.yarn',
  '.pnpm',
  '.cargo',
  '.rustup',
  '.go',
  '.m2',
  '.gradle',
  '.android',
  '.oracle_jre_usage',
  '.java',
  '.ldapvrc',
  '.dbshell',
  '.mysql_history',
  '.psql_history',
  '.rediscli_history',
  '.mongorc.js',
  '.mongohistory',
  '.mozilla',
  '.thunderbird',
  '.ICEauthority',
  '.Xauthority',
  '.xsession-errors',
  '.dmrc',
  '.esd_auth',
  '.pulse',
  '.pulse-cookie',
  '.recently-used',
  '.recently-used.xbel',
  '.configCode',
  '.vscode',
  '.vscode-server',
  '.claude',
  '.cursor',
  '.trae',
  '.zshrc',
  '.zsh_history',
  '.zprofile',
  '.zshenv',
  '.oh-my-zsh',
  '.p10k.zsh',
  '.tmux.conf',
  '.tmux',
  '.screenrc',
  '.inputrc',
  '.dir_colors',
  '.dircolors',
  '.emacs',
  '.emacs.d',
  '.spacemacs',
  '.ideavimrc',
  '.ctags',
  '.ackrc',
  '.ripgreprc',
  '.editorconfig',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
  '.terraform.d',
  '.ansible',
  '.kube',
  '.helm',
  '.ovh',
  '.aws',
  '.gcloud',
  '.azure',
  '.heroku',
  '.netrc',
  '.ssh_config',
  '.wgetrc',
  '.curlrc',
  '.git-credentials',
  '.mailmap',
  '.ignore',
  '.fdignore',
  '.rgignore',
  '.npmignore',
  '.dockerignore',
  '.eslintignore',
  '.prettierignore',
  '.gitignore'
]

// Probe common hidden files/directories via sftp.stat().
// Returns entries that exist but were missing from readdir.
const probeCommonHiddenFiles = async (sftp: any, reqPath: string, existingNames: string[]): Promise<any[]> => {
  const seen = new Set(existingNames)
  const found: any[] = []

  // Probe in parallel batches of 10 to avoid overwhelming the SFTP server
  const batchSize = 10
  for (let i = 0; i < COMMON_HIDDEN_NAMES.length; i += batchSize) {
    const batch = COMMON_HIDDEN_NAMES.slice(i, i + batchSize)
    const results = await Promise.allSettled(
      batch.map(async (name) => {
        if (seen.has(name)) return null
        // Skip subdirectory paths — only direct children belong in the listing
        if (name.includes('/')) return null
        const fullPath = reqPath === '/' ? `/${name}` : `${reqPath}/${name}`
        const st = await new Promise<any>((res, rej) => {
          sftp.stat(fullPath, (err: Error | null, s?: any) => (err ? rej(err) : res(s)))
        })
        return { filename: name, attrs: wrapSftpAttrs(st) }
      })
    )
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        seen.add(r.value.filename)
        found.push(r.value)
      }
    }
  }

  return found
}

export const execListDirViaSsh = async (conn: any, reqPath: string, timeout = 10000): Promise<string[]> => {
  const cmd = `ls -a -1 -- ${shellSingleQuote(reqPath)}`
  const promise = new Promise<string[]>((resolve) => {
    let settled = false
    const safeResolve = (names: string[]) => {
      if (settled) return
      settled = true
      resolve(names)
    }

    try {
      conn.exec(cmd, (err: any, stream: any) => {
        if (err) {
          sftpDebug('[sftp:list] exec fallback error', { path: reqPath, error: err.message })
          return safeResolve([])
        }

        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.stderr?.on('data', (chunk: Buffer) => {
          sftpDebug('[sftp:list] exec fallback stderr', { path: reqPath, data: chunk.toString('utf8') })
        })
        stream.on('close', () => {
          const stdout = Buffer.concat(chunks).toString('utf8')
          const names = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((name) => name && name !== '.' && name !== '..')
          safeResolve(names)
        })
      })
    } catch (e: any) {
      sftpDebug('[sftp:list] exec fallback exception', { path: reqPath, error: e.message })
      safeResolve([])
    }
  })

  return withTimeout(promise, timeout, `exec list timeout: ${reqPath}`).catch((e) => {
    sftpDebug('[sftp:list] exec fallback timeout', { path: reqPath, error: e.message })
    return []
  })
}

export const enrichReaddirWithExecFallback = async (conn: any, sftp: any, reqPath: string, list: any[]): Promise<any[]> => {
  const execNames = await execListDirViaSsh(conn, reqPath)
  if (!execNames.length) return list

  const existing = new Set(list.map((i) => i?.filename).filter(Boolean))
  const prefix = reqPath === '/' ? '/' : reqPath + '/'
  let added = 0

  for (const name of execNames) {
    if (existing.has(name)) continue
    try {
      const itemPath = prefix + name
      const st = await sftpStatWithTimeout(sftp, itemPath, 5000)
      list.push({ filename: name, attrs: wrapSftpAttrs(st) })
      added++
    } catch (e: any) {
      sftpDebug('[sftp:list] exec fallback stat failed', { path: prefix + name, error: e?.message || String(e) })
    }
  }

  sftpDebug('[sftp:list] exec fallback merged', { path: reqPath, execTotal: execNames.length, added })
  return list
}

export const readSftpDirWithFallback = async (
  sftp: any,
  reqPath: string,
  opts: { id: string; includeHidden?: boolean; label?: string; deps?: ListDeps }
): Promise<any[]> => {
  const id = opts.id
  const includeHidden = opts.includeHidden ?? false
  const label = opts.label ?? 'readdir result'
  const list = await sftpReaddirWithTimeout(sftp, reqPath, 10000)
  const rawNames = (list || []).map((i: any) => i?.filename).filter(Boolean)
  const dotFiles = rawNames.filter((n: string) => n.startsWith('.'))

  sftpDebug(`[sftp:list] ${label}`, {
    path: reqPath,
    includeHidden,
    total: rawNames.length,
    dotFileCount: dotFiles.length,
    dotFiles: dotFiles.slice(0, 20),
    allNames: rawNames.slice(0, 50)
  })

  // Only attempt exec fallback when the caller explicitly asks for hidden files
  // and the SFTP server/proxy (e.g. JumpServer) returned no dot files at all.
  // This avoids unnecessary SSH exec round-trips for normal listings.
  if (includeHidden && dotFiles.length === 0) {
    // Strategy 1: Use the underlying SSH connection directly (standard SSH)
    const conn = opts?.deps?.resolveSshConn?.(id)
    if (conn) {
      try {
        sftpDebug('[sftp:list] exec fallback via SSH conn', { path: reqPath, id })
        const result = await enrichReaddirWithExecFallback(conn, sftp, reqPath, list || [])
        if (result.length > (list || []).length) {
          sftpDebug('[sftp:list] exec fallback via SSH conn succeeded', {
            path: reqPath,
            before: (list || []).length,
            after: result.length
          })
          return result
        }
        sftpDebug('[sftp:list] exec fallback via SSH conn returned no extra entries', { path: reqPath })
      } catch (e: any) {
        sftpDebug('[sftp:list] exec fallback via SSH conn failed', { path: reqPath, error: e?.message || String(e) })
      }
    } else {
      sftpDebug('[sftp:list] no underlying SSH connection for exec fallback', { path: reqPath, id })
    }

    // Strategy 2: For JumpServer connections, try creating a dedicated exec stream
    // that navigates through the JumpServer to the target asset.
    const isJumpServer = id.includes('local-team') || id.includes(':local:')
    if (isJumpServer) {
      try {
        sftpDebug('[sftp:list] trying JumpServer exec stream fallback', { path: reqPath, id })
        // Strip :files-N suffix to get the terminal connection ID
        const terminalId = id.replace(/:files-\d+$/, '')
        const execStream = await opts?.deps?.createJumpServerExec?.(terminalId)
        if (execStream) {
          const cmd = `ls -a -1 -- ${shellSingleQuote(reqPath)}`
          const execResult = await opts?.deps?.execCommandOnJumpServer?.(execStream, cmd)
          if (execResult?.success && execResult.stdout) {
            const execNames = execResult.stdout
              .split('\n')
              .map((n: string) => n.trim())
              .filter((n: string) => n && n !== '.' && n !== '..')

            sftpDebug('[sftp:list] JumpServer exec stream succeeded', {
              path: reqPath,
              execNames: execNames.slice(0, 50)
            })

            const existing = new Set(rawNames)
            const missing = execNames.filter((n: string) => !existing.has(n))
            if (missing.length > 0) {
              const enriched = [...(list || [])]
              for (const name of missing) {
                const fullPath = reqPath === '/' ? `/${name}` : `${reqPath}/${name}`
                try {
                  const st = await new Promise<any>((res, rej) => {
                    sftp.stat(fullPath, (err: Error | null, s?: any) => (err ? rej(err) : res(s)))
                  })
                  enriched.push({ filename: name, attrs: wrapSftpAttrs(st) })
                } catch {
                  // stat failed — skip this entry
                  sftpDebug('[sftp:list] JumpServer exec stat failed for entry', { path: fullPath })
                }
              }
              if (enriched.length > (list || []).length) {
                return enriched
              }
            }
          } else {
            sftpDebug('[sftp:list] JumpServer exec stream returned no output', {
              path: reqPath,
              error: execResult?.error || 'no stdout'
            })
          }
        }
      } catch (e: any) {
        sftpDebug('[sftp:list] JumpServer exec stream fallback failed', {
          path: reqPath,
          error: e?.message || String(e)
        })
      }
    }

    // Strategy 3: Probe common hidden files via sftp.stat()
    // Works even when exec is unavailable (e.g. JumpServer SFTP proxy on port
    // 2222 intercepts the exec channel and returns menu text instead of ls
    // output). The SFTP server may filter dot files from readdir but still
    // allow stat on individual paths.
    {
      const probed = await probeCommonHiddenFiles(sftp, reqPath, rawNames)
      if (probed.length > 0) {
        const enriched = [...(list || []), ...probed]
        sftpDebug('[sftp:list] stat probe succeeded', {
          path: reqPath,
          probed: probed.length,
          total: enriched.length
        })
        return enriched
      }
    }
  }

  return list || []
}

export const formatSftpList = (list: any[], reqPath: string) => {
  const seen = new Set<string>()
  const result: any[] = []
  for (const item of list || []) {
    const name = item.filename
    if (seen.has(name)) continue // deduplicate
    seen.add(name)
    const attrs = item.attrs
    const prefix = reqPath === '/' ? '/' : reqPath + '/'
    result.push({
      name,
      path: prefix + name,
      isDir: attrs.isDirectory(),
      isLink: attrs.isSymbolicLink(),
      mode: '0' + (attrs.mode & 0o777).toString(8),
      modTime: fmtTime(new Date(attrs.mtime * 1000)),
      size: attrs.size
    })
  }
  return result
}

export async function listLocalDir(reqPath: string) {
  const abs = ensureAbsLocalPath(reqPath)

  let ents: import('fs').Dirent[]
  try {
    ents = await nodeFs.readdir(abs, { withFileTypes: true })
  } catch (err: any) {
    return [String(err?.message || err)]
  }

  const items: any[] = []

  for (const ent of ents) {
    const full = path.join(abs, ent.name)

    // Compatible with Windows files without permission
    let mode = '---'
    let modTime = ''
    let size = 0
    let isLink = ent.isSymbolicLink()

    try {
      const st = await nodeFs.lstat(full)
      mode = ((st.mode ?? 0) & 0o777).toString(8).padStart(3, '0')
      modTime = fmtTime(st.mtime ?? new Date(0))
      size = ent.isDirectory() ? 0 : Number(st.size || 0)
      isLink = st.isSymbolicLink?.() ? true : isLink
    } catch (err: any) {
      const code = String(err?.code || '')
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
        continue
      }
      continue
    }

    items.push({
      name: ent.name,
      path: toPosix(full),
      isDir: ent.isDirectory(),
      isLink,
      mode,
      modTime,
      size
    })
  }

  return items
}
