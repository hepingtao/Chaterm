// Pure path/label helpers shared by the desktop app and the CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import path from 'node:path'

export const isLocalId = (id: string) => id.includes('localhost@127.0.0.1:local:')
export const toPosix = (p: string) => String(p || '').replace(/\\/g, '/')

export const isJumpServerId = (id: string) => id.includes(':local:') || id.includes('local-team')

export const shellSingleQuote = (s: string): string => `'${s.replace(/'/g, "'\\''")}'`

export const pad2 = (n: number) => String(n).padStart(2, '0')
export const fmtTime = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`

export function normalizeWindowsDrive(p: string) {
  const s = String(p || '').trim()

  // "C:" / "c:" => "C:\"
  if (/^[a-zA-Z]:$/.test(s)) return s + '\\'

  // "C:/" => "C:\"
  if (/^[a-zA-Z]:\/$/.test(s)) return s.replace('/', '\\')

  return s
}

export function ensureAbsLocalPath(reqPath: string) {
  let p = String(reqPath || '').trim()

  if (process.platform === 'win32') {
    p = normalizeWindowsDrive(p)
    p = p.replace(/\//g, '\\')
  }

  return path.isAbsolute(p) ? p : path.resolve(p)
}

export const getSftpHostLabel = (id: string, sftp?: any) => {
  if (id.includes('local-team')) {
    const [, rest = ''] = String(id || '').split('@')
    const parts = rest.split(':')
    return (parts[2] ? Buffer.from(parts[2], 'base64').toString('utf-8') : '') || sftp?.host || id
  }
  return sftp?.host || id
}
