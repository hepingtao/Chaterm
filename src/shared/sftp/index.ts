// Public surface of the shared SFTP file-management core.
// Consumers: the Electron desktop adapter (src/main/ssh/sftpTransfer.ts)
// and the standalone CLI (src/cli). Everything here is Electron-free.

export * from './types'
export { setSftpDebug, sftpDebug } from './debug'
export { activeTasks, cancelActiveTask } from './tasks'
export { isLocalId, toPosix, normalizeWindowsDrive, ensureAbsLocalPath, isJumpServerId, shellSingleQuote, getSftpHostLabel } from './paths'
export {
  withTimeout,
  sftpStat,
  sftpReaddir,
  sftpStatWithTimeout,
  sftpReaddirWithTimeout,
  sftpRecursiveRmdir,
  sftpMkdir,
  isDirEntry,
  entryName,
  sftpStatSafe,
  isRemoteDirectoryStat,
  wrapSftpAttrs,
  sftpOpenForRead,
  sftpReadChunk,
  closeSftpHandleQuietly,
  waitStreamOpen,
  isRemoteDir,
  sftpMkdirSafe,
  sftpMkdirpForTransfer,
  createAsyncPool
} from './sftpAsync'
export { formatBackupSuffix, backupRemoteEntity, getUniqueRemoteName, findUniqueBackupName, sftpExists } from './uniqueName'
export { readSftpDirWithFallback, formatSftpList, execListDirViaSsh, enrichReaddirWithExecFallback, listLocalDir } from './list'
export { streamTransfer, directoryDownload, directoryUpload, fastDownloadFromSftp, shouldSkipUploadEntry } from './transfer'
export { transferFileR2R, transferDirR2R, copyOrMoveBySftp } from './r2r'
export { deleteRemote, renameRemote, chmodRemote } from './ops'
