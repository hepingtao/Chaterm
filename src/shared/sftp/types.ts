// Shared SFTP types for the file-management core used by both the Electron
// desktop app and the CLI. Must stay Electron-free.

export type SftpConnectResult = { status: string; message: string }

export type TaskStatus = 'running' | 'success' | 'failed' | 'error'
export type ErrorSide = 'from' | 'to' | 'remote' | 'local'
export type TransferStatus = 'success' | 'cancelled' | 'skipped' | 'error'

export interface TransferResult {
  status: TransferStatus
  message?: string
  code?: string
  taskKey?: string

  // host/ip labels for UI
  host?: string
  fromHost?: string
  toHost?: string

  // which side errored
  errorSide?: ErrorSide

  // common data
  remotePath?: string
  localPath?: string
  totalFiles?: number
}

export type GroupKind = 'directory' | 'file'

export interface ChildTaskOptions {
  parentTaskKey?: string
  taskKeyOverride?: string
  isGroup?: boolean
  groupKind?: GroupKind
}

export interface R2RFileArgs {
  fromId: string
  toId: string
  fromPath: string
  toPath: string
  autoRename?: boolean
}

export interface R2RDirArgs {
  fromId: string
  toId: string
  fromDir: string
  toDir: string
  autoRename?: boolean
  concurrency?: number
}

export interface CopyOrMoveBySftpArgs {
  id: string
  srcPath: string
  targetPath: string
  action: 'copy' | 'move'
}

export interface SftpCopyOrMoveResult {
  status: 'success' | 'error' | 'cancelled'
  message?: string
  path?: string
}

// A cancellable transfer task registered in the shared task registry.
export interface ActiveTaskRecord {
  read?: any
  write?: any
  localPath?: string
  cancel?: () => void
}

// Connection/progress hooks injected by the host (desktop app or CLI).
// The core never touches Electron or the desktop connection pools directly.
export interface SftpOpsDeps {
  // Resolve the live SFTP handle for a connection id (null when not connected).
  getSftp(id: string): any | null
  // Human-readable host label for progress payloads.
  getHostLabel(id: string, sftp?: any): string
  // Progress delivery. Desktop forwards to webContents; CLI renders a bar.
  emit(payload: Record<string, any>): void
  // Directory for R2R relay temp files.
  tempDir: string
  // Optional hidden-file listing strategies (desktop-only capabilities).
  resolveSshConn?(id: string): any
  createJumpServerExec?(terminalId: string): Promise<any | null>
  execCommandOnJumpServer?(stream: any, cmd: string): Promise<any>
}

// Optional capabilities for readSftpDirWithFallback.
export interface ListDeps {
  resolveSshConn?(id: string): any
  createJumpServerExec?(terminalId: string): Promise<any | null>
  execCommandOnJumpServer?(stream: any, cmd: string): Promise<any>
}
