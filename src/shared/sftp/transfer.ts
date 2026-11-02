// File/directory transfer orchestration shared by desktop and CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
// All connection lookups, progress delivery and temp paths arrive via SftpOpsDeps.
import fs from 'fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { activeTasks } from './tasks'
import {
  sftpStat,
  sftpReaddir,
  isDirEntry,
  entryName,
  sftpMkdirpForTransfer,
  createAsyncPool,
  sftpOpenForRead,
  sftpReadChunk,
  closeSftpHandleQuietly
} from './sftpAsync'
import { backupRemoteEntity } from './uniqueName'
import {
  markTransferSide,
  getMarkedTransferSide,
  createTransferCancelledError,
  isTransferCancelledError,
  errToMessage,
  isPrematureStreamError,
  getTotalUi,
  terminalBytes
} from './errors'
import { toPosix } from './paths'
import type { ChildTaskOptions, ErrorSide, SftpOpsDeps, TaskStatus, TransferResult } from './types'

export const shouldSkipUploadEntry = (name: string, isDirectory: boolean): boolean => {
  if (isDirectory) {
    return name === '__pycache__' || name === '.pytest_cache'
  }
  return name.endsWith('.pyc') || name.endsWith('.pyo')
}

const FAST_DOWNLOAD_CONCURRENCY = 64
const FAST_DOWNLOAD_CHUNK_SIZE = 32 * 1024

type FastDownloadControl = {
  abort?: () => void
}

export async function fastDownloadFromSftp(
  sftp: any,
  remotePath: string,
  localPath: string,
  options: {
    total: number
    isCancelled: () => boolean
    onProgress: (bytes: number, chunk: number) => void
    control: FastDownloadControl
  }
) {
  const total = Math.max(0, options.total || 0)

  if (total === 0) {
    if (options.isCancelled()) throw createTransferCancelledError()
    try {
      await fs.promises.writeFile(localPath, Buffer.alloc(0))
    } catch (e) {
      throw markTransferSide('local', e)
    }
    return 0
  }

  let remoteHandle: Buffer | null = null
  let localFile: any = null
  let nextOffset = 0
  let transferred = 0
  let stopping = false

  const throwIfCancelled = () => {
    if (options.isCancelled() || stopping) throw createTransferCancelledError()
  }

  const abortOpenHandles = () => {
    stopping = true
    void closeSftpHandleQuietly(sftp, remoteHandle)
    void localFile?.close?.().catch?.(() => {})
  }

  options.control.abort = abortOpenHandles

  try {
    throwIfCancelled()
    remoteHandle = await sftpOpenForRead(sftp, remotePath)

    throwIfCancelled()
    try {
      localFile = await fs.promises.open(localPath, 'w')
    } catch (e) {
      throw markTransferSide('local', e)
    }

    const workerCount = Math.min(FAST_DOWNLOAD_CONCURRENCY, Math.ceil(total / FAST_DOWNLOAD_CHUNK_SIZE))
    const worker = async () => {
      const buffer = Buffer.allocUnsafe(FAST_DOWNLOAD_CHUNK_SIZE)

      while (true) {
        throwIfCancelled()

        const offset = nextOffset
        if (offset >= total) return

        const length = Math.min(FAST_DOWNLOAD_CHUNK_SIZE, total - offset)
        nextOffset += length

        let chunkOffset = 0
        while (chunkOffset < length) {
          throwIfCancelled()

          const position = offset + chunkOffset
          const bytesRead = await sftpReadChunk(sftp, remoteHandle!, buffer, length - chunkOffset, position)
          if (bytesRead <= 0) throw markTransferSide('remote', new Error(`Unexpected EOF while reading ${remotePath}`))

          throwIfCancelled()
          try {
            await localFile.write(buffer, 0, bytesRead, position)
          } catch (e) {
            throw markTransferSide('local', e)
          }

          transferred += bytesRead
          options.onProgress(transferred, bytesRead)
          chunkOffset += bytesRead
        }
      }
    }

    let firstWorkerError: any = null
    const runWorker = async () => {
      try {
        await worker()
      } catch (e) {
        firstWorkerError ??= e
        abortOpenHandles()
        throw e
      }
    }

    await Promise.allSettled(Array.from({ length: workerCount }, () => runWorker()))
    if (firstWorkerError) throw firstWorkerError

    return transferred
  } catch (e) {
    if (options.isCancelled() || isTransferCancelledError(e)) throw createTransferCancelledError()
    throw e
  } finally {
    options.control.abort = undefined

    try {
      await localFile?.close?.()
    } catch {}
    await closeSftpHandleQuietly(sftp, remoteHandle)
  }
}

function hookStartOnce(rs: any, ws: any, startOnce: () => void) {
  rs?.once?.('open', startOnce)
  ws?.once?.('open', startOnce)
  rs?.once?.('error', startOnce)
  ws?.once?.('error', startOnce)
}

export async function streamTransfer(
  ctx: SftpOpsDeps,
  id: string,
  srcPath: string,
  destPath: string,
  type: 'download' | 'upload',
  isInternalCall = false,
  childOpts?: ChildTaskOptions
): Promise<TransferResult> {
  const emit = ctx.emit
  const sftp = ctx.getSftp(id)
  const host = ctx.getHostLabel(id, sftp)

  const rawFallbackTaskKey =
    type === 'download' ? `${id}:dl:${toPosix(srcPath)}:${path.resolve(destPath)}` : `${id}:up:${srcPath}:${toPosix(destPath)}`

  const progressFallbackTaskKey = childOpts?.taskKeyOverride || rawFallbackTaskKey

  const progressBase = (extra: Record<string, any> = {}) => ({
    id,
    host,
    taskKey: progressFallbackTaskKey,
    parentTaskKey: childOpts?.parentTaskKey,
    type,
    isGroup: childOpts?.isGroup ?? false,
    groupKind: childOpts?.groupKind ?? 'file',
    ...extra
  })

  if (!sftp) {
    emit(
      progressBase({
        remotePath: toPosix(srcPath),
        destPath,
        bytes: 1,
        total: 1,
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'remote'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote', taskKey: progressFallbackTaskKey }
  }

  let finalRemotePath = destPath
  let finalLocalPath = destPath
  let total = 0

  // Preserve local file's atime/mtime so we can set them on the remote file
  // after upload completes — SFTP createWriteStream sets mtime to upload time.
  let localAtime: Date | null = null
  let localMtime: Date | null = null

  if (type === 'download') {
    try {
      const st = await sftpStat(sftp, toPosix(srcPath))
      total = st?.size ?? 0
    } catch (e: any) {
      const msg = errToMessage(e)
      emit(
        progressBase({
          remotePath: toPosix(srcPath),
          destPath: path.resolve(destPath),
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'remote'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'remote' }
    }

    try {
      finalLocalPath = path.resolve(destPath)
      await fs.promises.mkdir(path.dirname(finalLocalPath), { recursive: true })
    } catch (e: any) {
      const msg = errToMessage(e)
      emit(
        progressBase({
          remotePath: toPosix(srcPath),
          destPath: finalLocalPath,
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'local'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'local' }
    }
  } else {
    try {
      const st = await fs.promises.stat(srcPath)
      total = st?.size ?? 0
      localAtime = st.atime
      localMtime = st.mtime
    } catch (e: any) {
      const msg = errToMessage(e)
      emit(
        progressBase({
          remotePath: toPosix(destPath),
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'local'
        })
      )
      return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'local' }
    }

    if (!isInternalCall) {
      try {
        const remoteDir = toPosix(destPath)
        const fileName = path.basename(srcPath)
        const targetRemotePath = path.posix.join(remoteDir, fileName)
        await backupRemoteEntity(sftp, targetRemotePath)
        finalRemotePath = targetRemotePath
      } catch (e: any) {
        const msg = errToMessage(e)
        emit(
          progressBase({
            remotePath: toPosix(destPath),
            bytes: 1,
            total: 1,
            status: 'error',
            message: msg,
            errorSide: 'remote'
          })
        )
        return { status: 'error', message: msg, code: e?.code, taskKey: progressFallbackTaskKey, host, errorSide: 'remote' }
      }
    } else {
      finalRemotePath = toPosix(destPath)
    }
  }

  const rawTaskKey = type === 'download' ? `${id}:dl:${toPosix(srcPath)}:${finalLocalPath}` : `${id}:up:${srcPath}:${finalRemotePath}`

  const progressTaskKey = childOpts?.taskKeyOverride || rawTaskKey

  if (activeTasks.has(progressTaskKey)) {
    return { status: 'skipped', message: 'Task already in progress', taskKey: progressTaskKey, host }
  }

  const totalUi = getTotalUi(total)

  let created = false
  const ensureCreated = () => {
    if (created) return
    created = true
    emit({
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: type === 'upload' ? finalRemotePath : toPosix(srcPath),
      destPath: type === 'download' ? finalLocalPath : undefined,
      bytes: 0,
      total: totalUi,
      status: 'running' as TaskStatus,
      stage: 'init'
    })
  }
  ensureCreated()

  let isCancelled = false
  let transferred = 0
  let lastEmitTime = 0

  const remotePathForUI = type === 'upload' ? finalRemotePath : toPosix(srcPath)
  const destPathForUI = type === 'download' ? finalLocalPath : undefined

  if (type === 'download') {
    const control: FastDownloadControl = {}

    activeTasks.set(progressTaskKey, {
      localPath: finalLocalPath,
      cancel: () => {
        isCancelled = true
        control.abort?.()
      }
    })

    const emitDownloadProgress = (bytes: number) => {
      transferred = bytes
      const now = Date.now()
      if (now - lastEmitTime > 150 || (total > 0 && transferred >= total)) {
        emit({
          id,
          host,
          taskKey: progressTaskKey,
          parentTaskKey: childOpts?.parentTaskKey,
          type,
          isGroup: childOpts?.isGroup ?? false,
          groupKind: childOpts?.groupKind ?? 'file',
          remotePath: remotePathForUI,
          destPath: destPathForUI,
          bytes: transferred,
          total: totalUi,
          status: 'running' as TaskStatus
        })
        lastEmitTime = now
      }
    }

    try {
      transferred = await fastDownloadFromSftp(sftp, remotePathForUI, finalLocalPath, {
        total,
        isCancelled: () => isCancelled,
        onProgress: emitDownloadProgress,
        control
      })
      activeTasks.delete(progressTaskKey)

      emit({
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: total > 0 ? total || transferred : 1,
        total: totalUi,
        status: 'success' as TaskStatus
      })

      return { status: 'success', remotePath: remotePathForUI, taskKey: progressTaskKey, host }
    } catch (e: any) {
      activeTasks.delete(progressTaskKey)

      if (isCancelled || isTransferCancelledError(e)) {
        emit({
          id,
          host,
          taskKey: progressTaskKey,
          parentTaskKey: childOpts?.parentTaskKey,
          type,
          isGroup: childOpts?.isGroup ?? false,
          groupKind: childOpts?.groupKind ?? 'file',
          remotePath: remotePathForUI,
          destPath: destPathForUI,
          bytes: terminalBytes(total),
          total: totalUi,
          status: 'failed' as TaskStatus,
          message: 'Transfer was cancelled by user',
          errorSide: 'local'
        })
        return { status: 'cancelled', message: 'Transfer was cancelled by user', taskKey: progressTaskKey, host, errorSide: 'local' }
      }

      const errorSide = getMarkedTransferSide(e) || 'remote'
      const msg = errToMessage(e)

      emit({
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'error' as TaskStatus,
        message: msg,
        errorSide
      })

      return { status: 'error', message: msg, code: e?.code, taskKey: progressTaskKey, host, errorSide }
    }
  }

  let readStream: any
  let writeStream: any

  let firstErr: any = null
  let firstErrSide: ErrorSide | null = null
  const markFirstErr = (side: ErrorSide, e: any) => {
    if (firstErr) return
    firstErr = e
    firstErrSide = side
  }

  try {
    readStream = fs.createReadStream(srcPath)
    readStream.once?.('error', (e: any) => markFirstErr('local', e))
  } catch (e: any) {
    const msg = errToMessage(e)
    const errorSide: ErrorSide = 'local'
    emit({
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })
    return { status: 'error', message: msg, code: e?.code, taskKey: progressTaskKey, host, errorSide }
  }

  try {
    writeStream = sftp.createWriteStream(finalRemotePath)
    writeStream.once?.('error', (e: any) => markFirstErr('remote', e))
  } catch (e: any) {
    const msg = errToMessage(e)
    const errorSide: ErrorSide = 'remote'
    emit({
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })
    return { status: 'error', message: msg, code: e?.code, taskKey: progressTaskKey, host, errorSide }
  }

  let readErr: any = null
  let writeErr: any = null

  readStream.on('error', (e: any) => {
    readErr ??= e
    if (!firstErr) {
      markFirstErr('local', e)
    }
  })

  writeStream.on('error', (e: any) => {
    writeErr ??= e
    if (!firstErr) {
      markFirstErr('remote', e)
    }
  })

  activeTasks.set(progressTaskKey, {
    read: readStream,
    write: writeStream,
    localPath: srcPath,
    cancel: () => {
      isCancelled = true
      readStream.destroy()
      writeStream.destroy()
    }
  })

  hookStartOnce(readStream, writeStream, ensureCreated)

  readStream.on('data', (chunk: Buffer) => {
    transferred += chunk.length
    const now = Date.now()
    if (now - lastEmitTime > 150 || (total > 0 && transferred >= total)) {
      emit({
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: transferred,
        total: totalUi,
        status: 'running' as TaskStatus
      })
      lastEmitTime = now
    }
  })

  try {
    await pipeline(readStream, writeStream)
    activeTasks.delete(progressTaskKey)

    // Preserve local file's modification time on the remote file
    if (type === 'upload' && localMtime && finalRemotePath) {
      try {
        const atimeSec = Math.floor((localAtime?.getTime() || localMtime.getTime()) / 1000)
        const mtimeSec = Math.floor(localMtime.getTime() / 1000)
        await new Promise<void>((res, rej) => {
          sftp.utimes(finalRemotePath, atimeSec, mtimeSec, (err: Error | null) => (err ? rej(err) : res()))
        })
      } catch {
        // utimes failure is non-fatal — file was uploaded successfully
      }
    }

    emit({
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: total > 0 ? total || transferred : 1,
      total: totalUi,
      status: 'success' as TaskStatus
    })

    return { status: 'success', remotePath: remotePathForUI, taskKey: progressTaskKey, host }
  } catch (e: any) {
    activeTasks.delete(progressTaskKey)

    if (isCancelled || isPrematureStreamError(e)) {
      emit({
        id,
        host,
        taskKey: progressTaskKey,
        parentTaskKey: childOpts?.parentTaskKey,
        type,
        isGroup: childOpts?.isGroup ?? false,
        groupKind: childOpts?.groupKind ?? 'file',
        remotePath: remotePathForUI,
        destPath: destPathForUI,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'failed' as TaskStatus,
        message: 'Transfer was cancelled by user',
        errorSide: 'local'
      })
      return { status: 'cancelled', message: 'Transfer was cancelled by user', taskKey: progressTaskKey, host, errorSide: 'local' }
    }

    const primaryErr = firstErr || readErr || writeErr || e
    const msg = errToMessage(primaryErr)

    let errorSide: ErrorSide
    if (firstErrSide) {
      errorSide = firstErrSide
    } else {
      errorSide = readErr ? 'local' : 'remote'
    }

    emit({
      id,
      host,
      taskKey: progressTaskKey,
      parentTaskKey: childOpts?.parentTaskKey,
      type,
      isGroup: childOpts?.isGroup ?? false,
      groupKind: childOpts?.groupKind ?? 'file',
      remotePath: remotePathForUI,
      destPath: destPathForUI,
      bytes: terminalBytes(total),
      total: totalUi,
      status: 'error' as TaskStatus,
      message: msg,
      errorSide
    })

    return { status: 'error', message: msg, code: primaryErr?.code, taskKey: progressTaskKey, host, errorSide }
  }
}

export async function directoryDownload(ctx: SftpOpsDeps, id: string, remoteDir: string, localDir: string): Promise<TransferResult> {
  const emit = ctx.emit
  const sftp = ctx.getSftp(id)
  const host = ctx.getHostLabel(id, sftp)

  const fromDir = toPosix(remoteDir)
  const toParent = path.resolve(localDir)
  const dirName = path.posix.basename(fromDir)
  const finalLocalBase = path.join(toParent, dirName)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${id}:dl-dir:${fromDir}:${finalLocalBase}:${nonce}`

  if (!sftp) {
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: 1,
      total: 1,
      status: 'error',
      message: 'Sftp Not connected',
      errorSide: 'remote'
    })
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote' }
  }

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  emit({
    id,
    host,
    taskKey: dirTaskKey,
    type: 'download',
    isGroup: true,
    groupKind: 'directory',
    remotePath: fromDir,
    destPath: finalLocalBase,
    bytes: 0,
    total: 1,
    status: 'running',
    stage: 'scanning'
  })

  try {
    await fs.promises.mkdir(finalLocalBase, { recursive: true })
  } catch (e: any) {
    const msg = errToMessage(e)
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'local'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'local' }
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  let scanCounter = 0
  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false

  const reportGroup = (extra?: Record<string, any>) => {
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: 'running',
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  const pool = createAsyncPool<{ r: string; l: string }>(async (t) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${t.r}`

    const r = await streamTransfer(ctx, id, t.r, t.l, 'download', true, {
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, 5)

  const scan = async (curFrom: string, curTo: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const list = await sftpReaddir(sftp, curFrom)
    for (const ent of list) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const name = entryName(ent)
      if (!name) continue

      const rPath = path.posix.join(curFrom, name)
      const lPath = path.join(curTo, name)

      if (isDirEntry(ent)) {
        await fs.promises.mkdir(lPath, { recursive: true })
        await scan(rPath, lPath)
      } else {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${rPath}`

        emit({
          id,
          host,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          type: 'download',
          isGroup: false,
          groupKind: 'file',
          remotePath: rPath,
          destPath: lPath,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ r: rPath, l: lPath })
      }
    }
  }

  try {
    await scan(fromDir, finalLocalBase)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'download',
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: finalLocalBase,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'local')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, host, errorSide: 'local' }
      : tr || { status: 'error', message: msg, host, errorSide: 'local' }
  }

  emit({
    id,
    host,
    taskKey: dirTaskKey,
    type: 'download',
    isGroup: true,
    groupKind: 'directory',
    remotePath: fromDir,
    destPath: finalLocalBase,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', localPath: finalLocalBase, host }
}

export async function directoryUpload(ctx: SftpOpsDeps, id: string, localDir: string, remoteDir: string): Promise<TransferResult> {
  const emit = ctx.emit
  const sftp = ctx.getSftp(id)
  const host = ctx.getHostLabel(id, sftp)

  const absLocal = path.resolve(localDir)
  const remoteParent = toPosix(remoteDir)
  const originalDirName = path.basename(absLocal)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${id}:up-dir:${absLocal}:${remoteParent}:${nonce}`

  if (!sftp) {
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: remoteParent,
      bytes: 1,
      total: 1,
      status: 'error',
      message: 'Sftp Not connected',
      errorSide: 'remote'
    })
    return { status: 'error', message: 'Sftp Not connected', host, errorSide: 'remote' }
  }

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  emit({
    id,
    host,
    taskKey: dirTaskKey,
    type: 'upload',
    isGroup: true,
    groupKind: 'directory',
    remotePath: remoteParent,
    bytes: 0,
    total: 1,
    status: 'running',
    stage: 'scanning'
  })

  try {
    const st = await fs.promises.stat(absLocal)
    if (!st.isDirectory()) throw Object.assign(new Error(`Not a directory: ${absLocal}`), { code: 'ENOTDIR' })
    await fs.promises.readdir(absLocal)
  } catch (e: any) {
    const msg = errToMessage(e)
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: remoteParent,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'local'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'local', localPath: absLocal }
  }

  const finalDirName = originalDirName
  const finalRemoteBaseDir = path.posix.join(remoteParent, finalDirName)

  try {
    await backupRemoteEntity(sftp, finalRemoteBaseDir)
  } catch (e: any) {
    const msg = errToMessage(e)
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'remote'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false
  let scanCounter = 0

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))

  const reportGroup = (extra?: Record<string, any>) => {
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: 'running',
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  try {
    await sftpMkdirpForTransfer(sftp, finalRemoteBaseDir)
  } catch (e: any) {
    const msg = errToMessage(e)
    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: 1,
      total: 1,
      status: 'error',
      message: msg,
      errorSide: 'remote'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  const pool = createAsyncPool<{ local: string; remote: string }>(async (task) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${task.remote}`

    const r = await streamTransfer(ctx, id, task.local, task.remote, 'upload', true, {
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, 3)

  const scan = async (currentLocal: string, currentRemote: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const entries = await fs.promises.readdir(currentLocal, { withFileTypes: true })

    for (const entry of entries) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      const name = entry.name
      // Skip Python bytecode artifacts and cache directories
      if (shouldSkipUploadEntry(name, entry.isDirectory())) continue

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const lPath = path.join(currentLocal, entry.name)
      const rPath = path.posix.join(currentRemote, entry.name)

      if (entry.isDirectory()) {
        await sftpMkdirpForTransfer(sftp, rPath)
        // Preserve local directory mtime on the remote
        try {
          const dst = await fs.promises.stat(lPath)
          const atimeSec = Math.floor(dst.atime.getTime() / 1000)
          const mtimeSec = Math.floor(dst.mtime.getTime() / 1000)
          await new Promise<void>((res, rej) => {
            sftp.utimes(rPath, atimeSec, mtimeSec, (err: Error | null) => (err ? rej(err) : res()))
          })
        } catch {
          // utimes failure is non-fatal
        }
        await scan(lPath, rPath)
      } else if (entry.isFile()) {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${rPath}`

        emit({
          id,
          host,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          type: 'upload',
          isGroup: false,
          groupKind: 'file',
          remotePath: rPath,
          localPath: lPath,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ local: lPath, remote: rPath })
      }
    }
  }

  try {
    await scan(absLocal, finalRemoteBaseDir)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    emit({
      id,
      host,
      taskKey: dirTaskKey,
      type: 'upload',
      isGroup: true,
      groupKind: 'directory',
      remotePath: finalRemoteBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'remote')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, host, errorSide: 'local' }
      : tr || { status: 'error', message: msg, host, errorSide: 'remote' }
  }

  emit({
    id,
    host,
    taskKey: dirTaskKey,
    type: 'upload',
    isGroup: true,
    groupKind: 'directory',
    remotePath: finalRemoteBaseDir,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', host }
}
