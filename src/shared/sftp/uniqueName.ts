// Remote backup/unique-name helpers shared by desktop and CLI.
// Extracted from src/main/ssh/sftpTransfer.ts — must stay Electron-free.
import path from 'node:path'
import { sftpStat } from './sftpAsync'
import { pad2, toPosix } from './paths'

// Backup helpers: before overwriting an existing remote file or directory,
// rename it to originalName.YYYYmmdd-HH24MMSS in the same parent directory.

export const formatBackupSuffix = (d: Date): string => {
  const yyyy = d.getFullYear()
  const mm = pad2(d.getMonth() + 1)
  const dd = pad2(d.getDate())
  const hh = pad2(d.getHours())
  const mi = pad2(d.getMinutes())
  const ss = pad2(d.getSeconds())
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`
}

const buildBackupName = (originalName: string, suffix: string): string => `${originalName}.${suffix}`

export const sftpExists = async (sftp: any, p: string): Promise<boolean> => {
  try {
    await sftpStat(sftp, p)
    return true
  } catch {
    return false
  }
}

export const findUniqueBackupName = async (sftp: any, parentDir: string, baseName: string): Promise<string> => {
  const suffix = formatBackupSuffix(new Date())
  let candidate = buildBackupName(baseName, suffix)
  let exists = await sftpExists(sftp, path.posix.join(parentDir, candidate))
  if (!exists) return candidate

  // Rare collision (same-second backup); append an incrementing counter.
  let counter = 1
  while (exists) {
    candidate = buildBackupName(baseName, `${suffix}.${counter}`)
    exists = await sftpExists(sftp, path.posix.join(parentDir, candidate))
    counter++
  }
  return candidate
}

export const backupRemoteEntity = async (sftp: any, remotePath: string): Promise<string | undefined> => {
  const normalized = toPosix(remotePath)
  const exists = await sftpExists(sftp, normalized)
  if (!exists) return undefined

  const parentDir = path.posix.dirname(normalized)
  const baseName = path.posix.basename(normalized)
  const backupName = await findUniqueBackupName(sftp, parentDir, baseName)
  const backupPath = path.posix.join(parentDir, backupName)

  await new Promise<void>((resolve, reject) => {
    sftp.rename(normalized, backupPath, (err: any) => (err ? reject(err) : resolve()))
  })

  return backupPath
}

// Pick a non-conflicting remote name: originalName when free, otherwise
// originalName.YYYYmmdd-HH24MISS (with an incrementing counter on same-second
// collisions). Mirrors sshHandle.getUniqueRemoteName semantics.
export const getUniqueRemoteName = async (sftp: any, remoteDir: string, originalName: string, isDir: boolean): Promise<string> => {
  const list = await new Promise<{ filename: string; longname: string; attrs: any }[]>((resolve, reject) => {
    sftp.readdir(remoteDir, (err: any, l: any) => (err ? reject(err) : resolve(l as any)))
  })
  let existing = new Set(list.map((f) => f.filename))

  if (isDir) {
    existing = new Set(list.filter((f) => f.attrs.isDirectory()).map((f) => f.filename))
  }

  // No conflict: keep original name
  if (!existing.has(originalName)) return originalName

  // Conflict: append timestamp suffix originalName.YYYYmmdd-HH24MISS
  const suffix = formatBackupSuffix(new Date())
  let finalName = `${originalName}.${suffix}`

  // Rare same-second collision: append incrementing counter
  let count = 1
  while (existing.has(finalName)) {
    finalName = `${originalName}.${suffix}.${count}`
    count++
  }

  return finalName
}
