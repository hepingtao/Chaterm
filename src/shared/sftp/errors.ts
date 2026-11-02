// Error tagging/cancellation helpers shared across the SFTP core.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import type { ErrorSide } from './types'

export const errToMessage = (e: any) => (e as Error)?.message || e?.message || String(e)

export const isPrematureStreamError = (e: any) => {
  const code = e?.code
  return code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END'
}

export const getTotalUi = (total: number) => (Number.isFinite(total) && total > 0 ? total : 1)

export const terminalBytes = (total: number) => getTotalUi(total)

export const markTransferSide = (side: ErrorSide, err: any) => {
  if (err && typeof err === 'object') {
    err.__errorSide ??= side
    return err
  }

  const wrapped = new Error(String(err))
  ;(wrapped as any).__errorSide = side
  return wrapped
}

export const getMarkedTransferSide = (err: any): ErrorSide | undefined => {
  const side = err?.__errorSide
  return side === 'local' || side === 'remote' ? side : undefined
}

export const createTransferCancelledError = () => Object.assign(new Error('Transfer was cancelled by user'), { __cancelled: true })

export const isTransferCancelledError = (err: any) => err?.__cancelled === true
