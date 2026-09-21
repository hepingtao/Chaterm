import { describe, expect, it } from 'vitest'
import { formatSftpList } from '../list'
import { formatBackupSuffix, getUniqueRemoteName } from '../uniqueName'
import { cancelActiveTask, activeTasks } from '../tasks'
import { chmodRemote, renameRemote } from '../ops'
import { normalizeWindowsDrive, toPosix } from '../paths'

describe('paths', () => {
  it('toPosix converts backslashes', () => {
    expect(toPosix('C:\\a\\b')).toBe('C:/a/b')
  })

  it('normalizeWindowsDrive appends root slash to bare drive', () => {
    expect(normalizeWindowsDrive('C:')).toBe('C:\\')
    expect(normalizeWindowsDrive('c:/')).toBe('c:\\')
    expect(normalizeWindowsDrive('C:\\data')).toBe('C:\\data')
  })
})

describe('formatBackupSuffix', () => {
  it('returns YYYYmmdd-HH24MMSS shape', () => {
    expect(formatBackupSuffix(new Date('2025-07-03T16:30:45'))).toBe('20250703-163045')
  })
})

describe('getUniqueRemoteName', () => {
  const sftpWith = (names: string[], isDir = false) => ({
    readdir: (_p: string, cb: (err: any, list?: any[]) => void) =>
      cb(
        null,
        names.map((n) => ({ filename: n, attrs: { isDirectory: () => isDir } }))
      )
  })

  it('keeps original name when free', async () => {
    const sftp = sftpWith([])
    await expect(getUniqueRemoteName(sftp, '/data', 'file.txt', false)).resolves.toBe('file.txt')
  })

  it('appends timestamp on conflict and counter on same-second collision', async () => {
    const suffix = formatBackupSuffix(new Date())
    const sftp = sftpWith(['file.txt', `file.txt.${suffix}`, `file.txt.${suffix}.1`])
    await expect(getUniqueRemoteName(sftp, '/data', 'file.txt', false)).resolves.toBe(`file.txt.${suffix}.2`)
  })
})

describe('formatSftpList', () => {
  it('maps raw readdir entries with posix paths and dedupes', () => {
    const st = (mode: number) => ({ mode, isDirectory: () => (mode & 0o170000) === 0o040000, isSymbolicLink: () => false, mtime: 0, size: 5 })
    const raw = [
      { filename: 'a', attrs: st(0o040755) },
      { filename: 'b.txt', attrs: st(0o100644) },
      { filename: 'a', attrs: st(0o040755) }
    ]
    const out = formatSftpList(raw, '/data')
    expect(out.map((i) => i.path)).toEqual(['/data/a', '/data/b.txt'])
    expect(out[0].isDir).toBe(true)
    expect(out[1].mode).toBe('0644')
  })
})

describe('tasks registry', () => {
  it('cancels a registered task and reports not_found otherwise', () => {
    const cancelled = { called: false }
    activeTasks.set('k1', { cancel: () => (cancelled.called = true) })
    expect(cancelActiveTask('k1')).toEqual({ status: 'aborted' })
    expect(cancelled.called).toBe(true)
    expect(cancelActiveTask('missing')).toEqual({ status: 'not_found' })
  })
})

describe('ops', () => {
  it('renameRemote no-ops when paths equal', async () => {
    const sftp = {
      rename: () => {
        throw new Error('should not be called')
      }
    }
    await expect(renameRemote(sftp, '/a', '/a')).resolves.toEqual({ status: 'success' })
  })

  it('chmodRemote applies octal mode and reports errors from sftp', async () => {
    const sftp = {
      chmod: (_p: string, _m: number, cb: (err?: Error) => void) => cb(undefined),
      readdir: (_p: string, cb: (err: any, list?: any[]) => void) => cb(null, [])
    }
    await expect(chmodRemote(sftp, '/a', '600', false)).resolves.toEqual({ status: 'success' })

    const failing = {
      chmod: (_p: string, _m: number, cb: (err?: Error) => void) => cb(new Error('Permission denied'))
    }
    await expect(chmodRemote(failing, '/a', '600', false)).resolves.toMatchObject({ status: 'error', message: 'Permission denied' })
  })
})
