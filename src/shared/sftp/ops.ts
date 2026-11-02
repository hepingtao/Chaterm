// Single-shot remote operations (delete/chmod/rename) shared by desktop and CLI.
// Response shapes mirror the original IPC handlers byte-for-byte.

import { sftpRecursiveRmdir } from './sftpAsync'

// Rejection reasons are plain strings, matching the original handler behavior
// (the renderer receives the same rejection message over IPC).
export const deleteRemote = async (sftp: any, remotePath: string): Promise<{ status: string; message: string; deletedPath?: string }> => {
  if (!sftp) {
    throw 'Sftp Not connected'
  }

  if (!remotePath || remotePath.trim() === '' || remotePath.trim() === '*' || remotePath === '/') {
    throw 'Illegal path, cannot be deleted'
  }

  // First try unlink (works for files). If it fails with a directory error,
  // fall back to recursive rmdir.
  try {
    await new Promise<void>((res, rej) => {
      sftp.unlink(remotePath, (err: any) => (err ? rej(err) : res()))
    })
    return { status: 'success', message: 'File deleted successfully', deletedPath: remotePath }
  } catch {
    let stats: any
    try {
      stats = await new Promise<any>((res, rej) => {
        sftp.stat(remotePath, (statErr: Error | null, s: any) => (statErr || !s ? rej(statErr || new Error('no stats')) : res(s)))
      })
    } catch (statErr: any) {
      const errorMessage = statErr instanceof Error ? statErr.message : String(statErr)
      throw `Delete failed: ${errorMessage}`
    }

    if (!stats.isDirectory()) {
      throw 'Delete failed: Not a directory and unlink failed'
    }

    try {
      await sftpRecursiveRmdir(sftp, remotePath)
      return { status: 'success', message: 'Directory deleted successfully', deletedPath: remotePath }
    } catch (rmdirErr: any) {
      const errorMessage = rmdirErr instanceof Error ? rmdirErr.message : String(rmdirErr)
      throw `Delete failed: ${errorMessage}`
    }
  }
}

export const renameRemote = async (sftp: any, oldPath: string, newPath: string): Promise<{ status: string; message?: string }> => {
  if (!sftp) return { status: 'error', message: 'Sftp Not connected' }

  try {
    if (oldPath === newPath) {
      return { status: 'success' }
    }
    await new Promise<void>((res, rej) => {
      sftp.rename(oldPath, newPath, (err: any) => (err ? rej(err) : res()))
    })
    return { status: 'success' }
  } catch (err) {
    return { status: 'error', message: (err as Error).message }
  }
}

export const chmodRemote = async (
  sftp: any,
  remotePath: string,
  mode: string | number,
  recursive: boolean
): Promise<{ status: string; message?: string }> => {
  if (!sftp) return { status: 'error', message: 'Sftp Not connected' }

  try {
    const parsedMode = parseInt(String(mode), 8)

    if (recursive) {
      const chmodRecursive = async (path: string): Promise<void> => {
        // Modify the permissions of the current path first
        await new Promise<void>((res, rej) => {
          sftp.chmod(path, parsedMode, (err: any) => (err ? rej(err) : res()))
        })

        // Retrieve directory contents
        const items = await new Promise<any[]>((res, rej) => {
          sftp.readdir(path, (err: any, list: any[]) => (err ? rej(err) : res(list || [])))
        })

        // Recursive processing of subdirectories and files
        for (const item of items) {
          if (item.filename === '.' || item.filename === '..') continue

          const itemPath = `${path}/${item.filename}`

          await new Promise<void>((res, rej) => {
            sftp.chmod(itemPath, parsedMode, (err: any) => (err ? rej(err) : res()))
          })

          if (item.attrs && item.attrs.isDirectory && item.attrs.isDirectory()) {
            await chmodRecursive(itemPath)
          }
        }
      }

      await chmodRecursive(remotePath)
    } else {
      await new Promise<void>((res, rej) => {
        sftp.chmod(remotePath, parsedMode, (err: any) => (err ? rej(err) : res()))
      })
    }

    return { status: 'success' }
  } catch (err) {
    return { status: 'error', message: (err as Error).message }
  }
}
