// Promise wrappers and low-level SFTP primitives shared by desktop and CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import { markTransferSide } from './errors'
import { toPosix } from './paths'

export const withTimeout = async <T>(promise: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: NodeJS.Timeout | null = null

  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message))
    }, ms)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Wrap ssh2 callback APIs so we can reuse them in reconnect checks.
export const sftpStat = async (sftp: any, p: string): Promise<any> => {
  return await new Promise<any>((resolve, reject) => {
    sftp.stat(p, (err: any, st: any) => (err ? reject(err) : resolve(st)))
  })
}

export const sftpReaddir = async (sftp: any, p: string): Promise<any[]> => {
  return await new Promise<any[]>((resolve, reject) => {
    sftp.readdir(p, (err: any, list: any[]) => (err ? reject(err) : resolve(list || [])))
  })
}

// Keep liveness checks bounded so stale SFTP handles fail fast.
export const sftpStatWithTimeout = async (sftp: any, p: string, timeout = 3000): Promise<any> => {
  return await withTimeout(sftpStat(sftp, p), timeout, `SFTP stat timeout: ${p}`)
}

export const sftpReaddirWithTimeout = async (sftp: any, p: string, timeout = 10000): Promise<any[]> => {
  return await withTimeout(sftpReaddir(sftp, p), timeout, `SFTP readdir timeout: ${p}`)
}

export const sftpRecursiveRmdir = async (sftp: any, dirPath: string): Promise<void> => {
  const entries = await new Promise<any[]>((res, rej) => {
    sftp.readdir(dirPath, (err: Error | null, list?: any[]) => {
      if (err) return rej(err)
      res(list || [])
    })
  })

  for (const entry of entries) {
    const name = entry.filename
    const fullPath = dirPath === '/' ? `/${name}` : `${dirPath}/${name}`
    const attrs = entry.attrs
    if (attrs && attrs.isDirectory()) {
      await sftpRecursiveRmdir(sftp, fullPath)
    } else {
      await new Promise<void>((res, rej) => {
        sftp.unlink(fullPath, (err: Error | null) => (err ? rej(err) : res()))
      })
    }
  }

  await new Promise<void>((res, rej) => {
    sftp.rmdir(dirPath, (err: Error | null) => (err ? rej(err) : res()))
  })
}

export function sftpMkdir(sftp: any, p: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.mkdir(p, (err: any) => {
      if (!err) return resolve()
      reject(err)
    })
  })
}

// R2R
export function isDirEntry(ent: any) {
  if (ent?.attrs?.isDirectory) return !!ent.attrs.isDirectory()
  if (typeof ent?.longname === 'string') return ent.longname.startsWith('d')
  return false
}

export function entryName(ent: any) {
  return ent?.filename ?? ent?.name
}

export async function sftpStatSafe(sftp: any, p: string): Promise<any | null> {
  try {
    return await sftpStat(sftp, p)
  } catch {
    return null
  }
}

export function isRemoteDirectoryStat(st: any) {
  return !!st?.isDirectory?.() || isRemoteDir(st)
}

// Wrap raw ssh2 stat attrs so the rest of the code can call isDirectory()/isSymbolicLink().
export const wrapSftpAttrs = (st: any): any => {
  return {
    ...st,
    isDirectory: () => isRemoteDir(st),
    isSymbolicLink: () => (st?.mode & 0o170000) === 0o120000,
    isFile: () => (st?.mode & 0o170000) === 0o100000
  }
}

export const sftpOpenForRead = async (sftp: any, remotePath: string): Promise<Buffer> => {
  return await new Promise<Buffer>((resolve, reject) => {
    sftp.open(remotePath, 'r', (err: any, handle: Buffer) => {
      if (err) reject(markTransferSide('remote', err))
      else resolve(handle)
    })
  })
}

export const sftpReadChunk = async (sftp: any, handle: Buffer, buffer: Buffer, length: number, position: number): Promise<number> => {
  return await new Promise<number>((resolve, reject) => {
    sftp.read(handle, buffer, 0, length, position, (err: any, bytesRead: number) => {
      if (err) reject(markTransferSide('remote', err))
      else resolve(bytesRead || 0)
    })
  })
}

export const closeSftpHandleQuietly = async (sftp: any, handle: Buffer | null) => {
  if (!handle) return

  await new Promise<void>((resolve) => {
    try {
      sftp.close(handle, () => resolve())
    } catch {
      resolve()
    }
  })
}

export function waitStreamOpen(stream: any) {
  return new Promise<void>((resolve, reject) => {
    let done = false
    const ok = () => {
      if (done) return
      done = true
      cleanup()
      resolve()
    }
    const bad = (e: any) => {
      if (done) return
      done = true
      cleanup()
      reject(e)
    }
    const cleanup = () => {
      stream?.off?.('open', ok)
      stream?.off?.('error', bad)
    }
    stream?.once?.('open', ok)
    stream?.once?.('error', bad)
  })
}

// ssh2 attrs.mode dir check
export const isRemoteDir = (st: any) => {
  const mode = st?.mode
  return typeof mode === 'number' && (mode & 0o170000) === 0o040000
}

// After the mkdir fails, check with stat. If it's already a directory, treat it as a success
export async function sftpMkdirSafe(sftp: any, dir: string) {
  try {
    await sftpMkdir(sftp, dir)
    return
  } catch (e: any) {
    try {
      const st = await sftpStat(sftp, dir)
      if (isRemoteDir(st)) return
    } catch {}
    throw e
  }
}

// mkdirp for real transfer output
const sftpMkdirRaw = (sftp: any, p: string) =>
  new Promise<void>((resolve, reject) => {
    sftp.mkdir(p, (err: any) => (err ? reject(err) : resolve()))
  })

export const sftpMkdirpForTransfer = async (sftp: any, dir: string) => {
  const d = toPosix(dir)
  if (!d || d === '/' || d === '.') return
  const parts = d.split('/').filter(Boolean)
  let cur = d.startsWith('/') ? '/' : ''
  for (const part of parts) {
    cur = cur === '/' ? `/${part}` : cur ? `${cur}/${part}` : part
    try {
      await sftpMkdirSafe(sftp, cur)
    } catch (e: any) {
      // fallback raw mkdir, then stat-if-exists
      try {
        await sftpMkdirRaw(sftp, cur)
      } catch (e2: any) {
        try {
          const st = await sftpStat(sftp, cur)
          if (isRemoteDir(st)) continue
        } catch {}
        throw e2
      }
    }
  }
}

export function createAsyncPool<T>(worker: (item: T) => Promise<void>, concurrency: number) {
  let active = 0
  let ended = false
  let firstError: any = null
  const queue: T[] = []

  let resolveWait: (() => void) | null = null
  let rejectWait: ((err: any) => void) | null = null

  const settleIfDone = () => {
    if (firstError) {
      rejectWait?.(firstError)
      resolveWait = null
      rejectWait = null
      return
    }
    if (ended && active === 0 && queue.length === 0) {
      resolveWait?.()
      resolveWait = null
      rejectWait = null
    }
  }

  const pump = () => {
    while (!firstError && active < concurrency && queue.length > 0) {
      const item = queue.shift()!
      active++
      Promise.resolve(worker(item))
        .catch((err) => {
          if (!firstError) firstError = err
        })
        .finally(() => {
          active--
          if (!firstError) pump()
          settleIfDone()
        })
    }
  }

  return {
    push(item: T) {
      if (firstError) throw firstError
      queue.push(item)
      pump()
    },
    end() {
      ended = true
      settleIfDone()
    },
    async wait() {
      if (firstError) throw firstError
      if (ended && active === 0 && queue.length === 0) return
      await new Promise<void>((resolve, reject) => {
        resolveWait = resolve
        rejectWait = reject
        pump()
        settleIfDone()
      })
      if (firstError) throw firstError
    }
  }
}
