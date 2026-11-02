// Minimal progress renderer for the CLI: consumes the same progress payloads
// the desktop app receives over IPC and renders one compact status line.

const humanBytes = (n: number): string => {
  if (!Number.isFinite(n) || n <= 0) return '0B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)}${units[i]}`
}

const describe = (p: Record<string, any>): string => {
  const kind = p.isGroup ? (p.groupKind === 'directory' ? 'dir' : 'group') : 'file'
  const stage = p.stage ? ` [${p.stage}]` : ''
  if (p.isGroup) {
    const files = `${p.finishedFiles ?? 0}/${p.totalFiles ?? p.total ?? '?'}`
    return `${kind}${stage} ${p.remotePath ?? ''} -> ${p.destPath ?? ''} files ${files}`
  }
  const pct = p.total > 0 ? ` ${Math.min(100, Math.floor(((p.bytes ?? 0) / p.total) * 100))}%` : ''
  return `${kind}${stage} ${p.remotePath ?? p.destPath ?? ''} ${humanBytes(p.bytes ?? 0)}/${humanBytes(p.total ?? 0)}${pct}`
}

export type ProgressSink = (payload: Record<string, any>) => void

export const createProgressRenderer = (quiet: boolean): ProgressSink => {
  if (quiet) return () => {}

  let lastLen = 0
  const draw = (text: string) => {
    if (!process.stderr.isTTY) return
    process.stderr.write(`\r${' '.repeat(lastLen)}\r${text}`)
    lastLen = text.length
  }

  return (payload) => {
    const status = payload?.status
    if (status && status !== 'running') {
      draw('')
      const mark = status === 'success' ? '✓' : status === 'cancelled' ? '✗ cancelled' : '✗'
      process.stderr.write(`${mark} ${describe(payload)}${status === 'error' ? ` — ${payload.message ?? ''}` : ''}\n`)
      lastLen = 0
      return
    }
    draw(`⇅ ${describe(payload)}`)
  }
}
