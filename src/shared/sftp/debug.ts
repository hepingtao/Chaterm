// Debug sink for the shared SFTP core. The desktop adapter wires this to its
// file-based HOME debug logger; the CLI can wire it to stderr or leave it off.

type SftpDebugFn = (message: string, data?: any) => void

let debugFn: SftpDebugFn = () => {}

export const setSftpDebug = (fn: SftpDebugFn) => {
  debugFn = fn
}

export const sftpDebug = (message: string, data?: any) => {
  try {
    debugFn(message, data)
  } catch {
    // debug logging must never break transfers
  }
}
