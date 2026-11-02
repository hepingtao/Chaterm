// Remote-to-remote transfer and remote copy/move, shared by desktop and CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import nodeFs from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { activeTasks } from './tasks'
import {
  sftpStat,
  sftpReaddir,
  sftpStatSafe,
  isRemoteDirectoryStat,
  isDirEntry,
  entryName,
  sftpMkdirSafe,
  waitStreamOpen,
  createAsyncPool
} from './sftpAsync'
import { getUniqueRemoteName } from './uniqueName'
import { toPosix, ensureAbsLocalPath, isLocalId } from './paths'
import { errToMessage, isPrematureStreamError, getTotalUi, terminalBytes } from './errors'
import { streamTransfer } from './transfer'
import type {
  TaskStatus,
  ChildTaskOptions,
  CopyOrMoveBySftpArgs,
  ErrorSide,
  GroupKind,
  R2RDirArgs,
  R2RFileArgs,
  SftpCopyOrMoveResult,
  SftpOpsDeps,
  TransferResult
} from './types'

const relayFileR2RViaLocal = async (
  ctx: SftpOpsDeps,
  args: R2RFileArgs & ChildTaskOptions,
  fromPath: string,
  toPath: string,
  progressTaskKey: string,
  base: { fromHost: string; toHost: string; parentTaskKey?: string; isGroup?: boolean; groupKind?: GroupKind }
): Promise<TransferResult> => {
  const { fromHost, toHost } = base
  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const tempPath = path.join(ctx.tempDir, `r2r-relay-${nonce}${path.posix.extname(fromPath) || ''}`)

  const emit = (extra: Record<string, any> = {}) =>
    emit({
      type: 'r2r',
      fromId: args.fromId,
      toId: args.toId,
      fromHost,
      toHost,
      taskKey: progressTaskKey,
      parentTaskKey: base.parentTaskKey,
      isGroup: base.isGroup ?? false,
      groupKind: base.groupKind ?? 'file',
      ...extra
    })

  emit({ remotePath: fromPath, destPath: toPath, status: 'running', stage: 'relaying', message: 'Relaying via local' })

  try {
    const dl = await streamTransfer(ctx, args.fromId, fromPath, tempPath, 'download', true, {
      parentTaskKey: base.parentTaskKey,
      taskKeyOverride: progressTaskKey,
      isGroup: base.isGroup ?? false,
      groupKind: base.groupKind ?? 'file'
    })
    if (dl?.status !== 'success') {
      emit({ remotePath: fromPath, destPath: toPath, status: 'error', message: dl?.message || 'Relay download failed', errorSide: 'from' })
      return { status: 'error', message: dl?.message || 'Relay download failed', taskKey: progressTaskKey, fromHost, toHost, errorSide: 'from' }
    }

    const up = await streamTransfer(ctx, args.toId, tempPath, toPath, 'upload', true, {
      parentTaskKey: base.parentTaskKey,
      taskKeyOverride: progressTaskKey,
      isGroup: base.isGroup ?? false,
      groupKind: base.groupKind ?? 'file'
    })
    if (up?.status !== 'success') {
      emit({ remotePath: fromPath, destPath: toPath, status: 'error', message: up?.message || 'Relay upload failed', errorSide: 'to' })
      return { status: 'error', message: up?.message || 'Relay upload failed', taskKey: progressTaskKey, fromHost, toHost, errorSide: 'to' }
    }

    emit({ remotePath: fromPath, destPath: toPath, status: 'success' })
    return { status: 'success', remotePath: toPath, taskKey: progressTaskKey, fromHost, toHost }
  } catch (e: any) {
    const msg = errToMessage(e)
    emit({ remotePath: fromPath, destPath: toPath, status: 'error', message: msg, errorSide: 'local' })
    return { status: 'error', message: msg, taskKey: progressTaskKey, fromHost, toHost, errorSide: 'local' }
  } finally {
    try {
      await nodeFs.unlink(tempPath)
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function transferFileR2R(ctx: SftpOpsDeps, args: R2RFileArgs & ChildTaskOptions): Promise<TransferResult> {
  const emit = ctx.emit
  const srcSftp = ctx.getSftp(args.fromId)
  const dstSftp = ctx.getSftp(args.toId)

  const fromHost = ctx.getHostLabel(args.fromId, srcSftp)
  const toHost = ctx.getHostLabel(args.toId, dstSftp)

  const fromPath = toPosix(args.fromPath)
  let toPath = toPosix(args.toPath)

  const rawTaskKeyBase = `${args.fromId}->${args.toId}:r2r:${fromPath}:${toPath}`
  const progressTaskKeyBase = args.taskKeyOverride || rawTaskKeyBase

  const progressBase = (extra: Record<string, any> = {}) => ({
    type: 'r2r',
    fromId: args.fromId,
    toId: args.toId,
    fromHost,
    toHost,
    taskKey: progressTaskKeyBase,
    parentTaskKey: args.parentTaskKey,
    isGroup: args.isGroup ?? false,
    groupKind: args.groupKind ?? 'file',
    ...extra
  })

  if (!srcSftp) {
    emit(
      progressBase({
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'from'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', fromHost, toHost, errorSide: 'from', taskKey: progressTaskKeyBase }
  }

  if (!dstSftp) {
    emit(
      progressBase({
        status: 'error',
        message: 'Sftp Not connected',
        errorSide: 'to'
      })
    )
    return { status: 'error', message: 'Sftp Not connected', fromHost, toHost, errorSide: 'to', taskKey: progressTaskKeyBase }
  }

  const autoRename = args.autoRename !== false

  let total = 0
  try {
    const st = await sftpStat(srcSftp, fromPath)
    total = st?.size ?? 0
  } catch (e: any) {
    const msg = errToMessage(e)
    emit(
      progressBase({
        remotePath: fromPath,
        destPath: toPath,
        bytes: 1,
        total: 1,
        status: 'error',
        message: msg,
        errorSide: 'from'
      })
    )
    return { status: 'error', message: msg, taskKey: progressTaskKeyBase, fromHost, toHost, errorSide: 'from' }
  }

  if (autoRename) {
    try {
      const dir = path.posix.dirname(toPath)
      const base = path.posix.basename(toPath)
      const unique = await getUniqueRemoteName(dstSftp, dir, base, false)
      toPath = path.posix.join(dir, unique)
    } catch (e: any) {
      const msg = errToMessage(e)
      emit(
        progressBase({
          remotePath: fromPath,
          destPath: toPath,
          bytes: 1,
          total: 1,
          status: 'error',
          message: msg,
          errorSide: 'to'
        })
      )
      return { status: 'error', message: msg, taskKey: progressTaskKeyBase, fromHost, toHost, errorSide: 'to' }
    }
  }

  const rawTaskKey = `${args.fromId}->${args.toId}:r2r:${fromPath}:${toPath}`
  const progressTaskKey = args.taskKeyOverride || rawTaskKey

  if (activeTasks.has(progressTaskKey)) {
    return { status: 'skipped', message: 'Task already in progress', taskKey: progressTaskKey, fromHost, toHost }
  }

  const totalUi = getTotalUi(total)

  let created = false
  const ensureCreated = () => {
    if (created) return
    created = true
    emit(
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: 0,
        total: totalUi,
        status: 'running' as TaskStatus,
        stage: 'init'
      })
    )
  }
  ensureCreated()

  let transferred = 0
  let lastEmitTime = 0
  let isCancelled = false

  let rs: any
  let ws: any

  let firstErr: any = null
  let firstSide: ErrorSide | null = null
  const markFirst = (side: ErrorSide, e: any) => {
    if (!firstErr) {
      firstErr = e
      firstSide = side
    }
  }

  try {
    rs = srcSftp.createReadStream(fromPath)
    rs.once('error', (e: any) => markFirst('from', e))

    await waitStreamOpen(rs)

    ws = dstSftp.createWriteStream(toPath, { flags: 'w' })
    ws.once('error', (e: any) => markFirst('to', e))

    activeTasks.set(progressTaskKey, {
      read: rs,
      write: ws,
      cancel: () => {
        isCancelled = true
        rs.destroy()
        ws.destroy()
      }
    })

    rs.on('data', (chunk: Buffer) => {
      transferred += chunk.length
      const now = Date.now()
      if (now - lastEmitTime > 150 || (total > 0 && transferred >= total)) {
        emit(
          progressBase({
            taskKey: progressTaskKey,
            remotePath: fromPath,
            destPath: toPath,
            bytes: transferred,
            total: totalUi,
            status: 'running' as TaskStatus
          })
        )
        lastEmitTime = now
      }
    })

    await pipeline(rs, ws)
    activeTasks.delete(progressTaskKey)

    emit(
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'success' as TaskStatus
      })
    )

    return { status: 'success', remotePath: toPath, taskKey: progressTaskKey, fromHost, toHost }
  } catch (e: any) {
    activeTasks.delete(progressTaskKey)

    if (isCancelled || isPrematureStreamError(e)) {
      emit(
        progressBase({
          taskKey: progressTaskKey,
          remotePath: fromPath,
          destPath: toPath,
          bytes: terminalBytes(total),
          total: totalUi,
          status: 'failed' as TaskStatus,
          message: 'Transfer cancelled',
          errorSide: 'local'
        })
      )
      return { status: 'cancelled', message: 'Transfer cancelled', taskKey: progressTaskKey, fromHost, toHost, errorSide: 'local' }
    }

    const primaryErr = firstErr || e
    const msg = errToMessage(primaryErr)
    const errorSide: ErrorSide = firstSide || 'from'

    // Direct host-to-host streaming failed. Retry by relaying through a local
    // temp file: download from the source, then upload to the destination.
    // This succeeds when the two remotes cannot reach each other directly but
    // each can reach this machine.
    const relay = await relayFileR2RViaLocal(ctx, args, fromPath, toPath, progressTaskKey, {
      fromHost,
      toHost,
      parentTaskKey: args.parentTaskKey,
      isGroup: args.isGroup ?? false,
      groupKind: args.groupKind ?? 'file'
    })
    if (relay?.status === 'success') {
      return relay
    }

    emit(
      progressBase({
        taskKey: progressTaskKey,
        remotePath: fromPath,
        destPath: toPath,
        bytes: terminalBytes(total),
        total: totalUi,
        status: 'error' as TaskStatus,
        message: msg,
        errorSide
      })
    )

    return { status: 'error', message: msg, code: primaryErr?.code, taskKey: progressTaskKey, fromHost, toHost, errorSide }
  }
}

export async function transferDirR2R(ctx: SftpOpsDeps, args: R2RDirArgs): Promise<TransferResult> {
  const emit = ctx.emit
  const srcSftp = ctx.getSftp(args.fromId)
  const dstSftp = ctx.getSftp(args.toId)

  const fromHost = ctx.getHostLabel(args.fromId, srcSftp)
  const toHost = ctx.getHostLabel(args.toId, dstSftp)

  const fromDir = toPosix(args.fromDir)
  const toParent = toPosix(args.toDir)

  const nonce = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`
  const dirTaskKey = `${args.fromId}->${args.toId}:r2r-dir:${fromDir}:${toParent}:${nonce}`

  const sendGroup = (extra?: Record<string, any>) =>
    emit({
      type: 'r2r',
      fromId: args.fromId,
      toId: args.toId,
      fromHost,
      toHost,
      taskKey: dirTaskKey,
      isGroup: true,
      groupKind: 'directory',
      remotePath: fromDir,
      destPath: toParent,
      bytes: 0,
      total: 1,
      status: 'running',
      stage: 'scanning',
      ...extra
    })

  if (!srcSftp || !dstSftp) {
    const errorSide: ErrorSide = !srcSftp ? 'from' : 'to'
    const msg = 'Sftp Not connected'
    sendGroup({ status: 'error', message: msg, bytes: 1, total: 1, stage: undefined, errorSide })
    return { status: 'error', message: msg, fromHost, toHost, errorSide }
  }

  let cancelled = false
  activeTasks.set(dirTaskKey, {
    cancel: () => {
      cancelled = true
    }
  })

  const autoRename = args.autoRename !== false
  const concurrency = args.concurrency ?? 3

  const originalDirName = path.posix.basename(fromDir)
  let finalDirName = originalDirName
  try {
    finalDirName = autoRename ? await getUniqueRemoteName(dstSftp, toParent, originalDirName, true) : originalDirName
  } catch (e: any) {
    const msg = errToMessage(e)
    sendGroup({ status: 'error', message: msg, bytes: 1, total: 1, stage: undefined, errorSide: 'to' })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, fromHost, toHost, errorSide: 'to' }
  }

  const finalToBaseDir = path.posix.join(toParent, finalDirName)

  try {
    await sftpMkdirSafe(dstSftp, finalToBaseDir)
  } catch (e: any) {
    const msg = errToMessage(e)
    sendGroup({
      destPath: finalToBaseDir,
      status: 'error',
      message: msg,
      bytes: 1,
      total: 1,
      stage: undefined,
      errorSide: 'to'
    })
    activeTasks.delete(dirTaskKey)
    return { status: 'error', message: msg, fromHost, toHost, remotePath: finalToBaseDir, errorSide: 'to' }
  }

  const yieldNow = () => new Promise<void>((r) => setImmediate(r))
  let scanCounter = 0
  let scannedFiles = 0
  let finishedFiles = 0
  let failedFiles = 0
  let transferStarted = false

  const reportGroup = (extra?: Record<string, any>) => {
    sendGroup({
      destPath: finalToBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      stage: transferStarted ? 'transferring' : 'scanning',
      ...extra
    })
  }

  const pool = createAsyncPool<{ from: string; to: string }>(async (f) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    transferStarted = true
    const fileTaskKey = `${dirTaskKey}:file:${f.to}`

    const r = await transferFileR2R(ctx, {
      fromId: args.fromId,
      toId: args.toId,
      fromPath: f.from,
      toPath: f.to,
      autoRename: false,
      parentTaskKey: dirTaskKey,
      taskKeyOverride: fileTaskKey,
      isGroup: false,
      groupKind: 'file'
    })

    if (r?.status !== 'success') throw r

    finishedFiles++
    reportGroup()
  }, concurrency)

  const scan = async (curFrom: string, curTo: string) => {
    if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

    const list = await sftpReaddir(srcSftp, curFrom)
    for (const ent of list) {
      if (cancelled) throw Object.assign(new Error('Transfer cancelled'), { __cancelled: true })

      scanCounter++
      if (scanCounter % 200 === 0) {
        reportGroup()
        await yieldNow()
      }

      const name = entryName(ent)
      if (!name) continue

      const s = path.posix.join(curFrom, name)
      const d = path.posix.join(curTo, name)

      if (isDirEntry(ent)) {
        await sftpMkdirSafe(dstSftp, d)
        await scan(s, d)
      } else {
        scannedFiles++
        const fileTaskKey = `${dirTaskKey}:file:${d}`

        emit({
          type: 'r2r',
          fromId: args.fromId,
          toId: args.toId,
          fromHost,
          toHost,
          parentTaskKey: dirTaskKey,
          taskKey: fileTaskKey,
          isGroup: false,
          groupKind: 'file',
          remotePath: s,
          destPath: d,
          bytes: 0,
          total: 1,
          status: 'running',
          stage: 'pending'
        })

        pool.push({ from: s, to: d })
      }
    }
  }

  try {
    await scan(fromDir, finalToBaseDir)
    pool.end()
    await pool.wait()
  } catch (e: any) {
    const isCancel = !!e?.__cancelled
    const tr = e?.status ? (e as TransferResult) : null
    const msg = tr?.message || errToMessage(e)

    if (tr?.status !== 'success') failedFiles++

    sendGroup({
      destPath: finalToBaseDir,
      bytes: finishedFiles,
      total: Math.max(scannedFiles, 1),
      totalFiles: scannedFiles,
      finishedFiles,
      failedFiles,
      status: isCancel ? 'failed' : 'error',
      message: msg,
      stage: undefined,
      errorSide: tr?.errorSide || (isCancel ? 'local' : 'to')
    })

    activeTasks.delete(dirTaskKey)
    return isCancel
      ? { status: 'cancelled', message: msg, fromHost, toHost, errorSide: 'local' }
      : tr || { status: 'error', message: msg, fromHost, toHost, errorSide: 'to' }
  }

  sendGroup({
    destPath: finalToBaseDir,
    bytes: finishedFiles,
    total: Math.max(scannedFiles, 1),
    totalFiles: scannedFiles,
    finishedFiles,
    failedFiles,
    status: 'success',
    stage: undefined
  })

  activeTasks.delete(dirTaskKey)
  return { status: 'success', remotePath: finalToBaseDir, totalFiles: scannedFiles, fromHost, toHost }
}

async function resolveRemoteCopyMoveTarget(
  sftp: any,
  srcPath: string,
  targetPath: string
): Promise<{
  srcStat: any
  finalPath: string
  isDir: boolean
}> {
  const normalizedSrc = toPosix(srcPath)
  const normalizedTarget = toPosix(targetPath)

  const srcStat = await sftpStat(sftp, normalizedSrc)
  const isDir = isRemoteDirectoryStat(srcStat)
  const srcBaseName = path.posix.basename(normalizedSrc)

  const targetStat = await sftpStatSafe(sftp, normalizedTarget)

  let candidatePath = normalizedTarget

  if (targetStat && isRemoteDirectoryStat(targetStat)) {
    candidatePath = path.posix.join(normalizedTarget, srcBaseName)
  } else if (normalizedTarget.endsWith('/')) {
    candidatePath = path.posix.join(normalizedTarget, srcBaseName)
  }

  const parentDir = path.posix.dirname(candidatePath)
  const baseName = path.posix.basename(candidatePath)
  const uniqueName = await getUniqueRemoteName(sftp, parentDir, baseName, isDir)
  const finalPath = path.posix.join(parentDir, uniqueName)

  return {
    srcStat,
    finalPath,
    isDir
  }
}

export async function copyOrMoveBySftp(ctx: SftpOpsDeps, args: CopyOrMoveBySftpArgs): Promise<SftpCopyOrMoveResult> {
  const { id, srcPath, targetPath, action } = args

  // Handle local file system copy/move
  if (isLocalId(id)) {
    try {
      const srcAbs = ensureAbsLocalPath(srcPath)
      const targetAbs = ensureAbsLocalPath(targetPath)
      const srcName = path.basename(srcAbs)
      const destPath = path.join(targetAbs, srcName)

      if (action === 'move') {
        if (srcAbs === destPath) return { status: 'success', path: destPath }
        await nodeFs.rename(srcAbs, destPath)
        return { status: 'success', path: destPath }
      }

      // Copy: use recursive copy
      const st = await nodeFs.stat(srcAbs)
      if (st.isDirectory()) {
        await nodeFs.cp(srcAbs, destPath, { recursive: true })
      } else {
        await nodeFs.copyFile(srcAbs, destPath)
      }
      return { status: 'success', path: destPath }
    } catch (err: any) {
      return { status: 'error', message: String(err?.message || err) }
    }
  }

  const sftp = ctx.getSftp(id)

  if (!sftp) {
    return { status: 'error', message: 'Sftp Not connected' }
  }

  try {
    const { finalPath, isDir } = await resolveRemoteCopyMoveTarget(sftp, srcPath, targetPath)

    if (action === 'move') {
      if (toPosix(srcPath) === finalPath) {
        return { status: 'success', path: finalPath }
      }

      await new Promise<void>((resolve, reject) => {
        sftp.rename(toPosix(srcPath), finalPath, (err: any) => {
          if (err) reject(err)
          else resolve()
        })
      })

      return {
        status: 'success',
        path: finalPath
      }
    }

    if (isDir) {
      const res = await transferDirR2R(ctx, {
        fromId: id,
        toId: id,
        fromDir: toPosix(srcPath),
        toDir: path.posix.dirname(finalPath),
        autoRename: false
      })

      if (res.status === 'success') {
        return {
          status: 'success',
          path: res.remotePath || finalPath
        }
      }

      if (res.status === 'cancelled') {
        return {
          status: 'cancelled',
          message: res.message
        }
      }

      return {
        status: 'error',
        message: res.message || 'Copy directory failed'
      }
    }

    const res = await transferFileR2R(ctx, {
      fromId: id,
      toId: id,
      fromPath: toPosix(srcPath),
      toPath: finalPath,
      autoRename: false
    })

    if (res.status === 'success') {
      return {
        status: 'success',
        path: res.remotePath || finalPath
      }
    }

    if (res.status === 'cancelled') {
      return {
        status: 'cancelled',
        message: res.message
      }
    }

    return {
      status: 'error',
      message: res.message || 'Copy file failed'
    }
  } catch (e: any) {
    return {
      status: 'error',
      message: e?.message || String(e)
    }
  }
}
