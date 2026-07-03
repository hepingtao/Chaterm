import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockSftp = {
  stat: ReturnType<typeof vi.fn>
  rename: ReturnType<typeof vi.fn>
}

const createMockSftp = (entries: Record<string, { isDirectory?: boolean }> = {}): MockSftp => {
  const normalize = (p: string) => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const store = new Map<string, { isDirectory?: boolean }>()

  for (const [k, v] of Object.entries(entries)) {
    store.set(normalize(k), v)
  }

  return {
    stat: vi.fn((p: string, cb: (err?: Error | null, st?: any) => void) => {
      const key = normalize(p)
      if (store.has(key)) {
        const entry = store.get(key)!
        cb(null, {
          isDirectory: () => !!entry.isDirectory,
          ...entry
        })
      } else {
        cb(Object.assign(new Error('No such file'), { code: 2 }))
      }
    }),
    rename: vi.fn((from: string, to: string, cb: (err?: Error | null) => void) => {
      const fromKey = normalize(from)
      const toKey = normalize(to)
      if (!store.has(fromKey)) {
        cb(Object.assign(new Error('No such file'), { code: 2 }))
        return
      }
      store.set(toKey, store.get(fromKey)!)
      store.delete(fromKey)
      cb(null)
    })
  }
}

const setupModule = async () => {
  vi.resetModules()

  vi.doMock('electron', () => ({
    app: { getPath: vi.fn(() => '/tmp') },
    ipcMain: { handle: vi.fn(), on: vi.fn(), once: vi.fn(), removeAllListeners: vi.fn() }
  }))

  vi.doMock('ssh2', () => ({
    Client: vi.fn()
  }))

  vi.doMock('../sshHandle', () => ({
    getSftpConnection: vi.fn(),
    getUniqueRemoteName: vi.fn(),
    pickReconnectConnectionInfo: vi.fn(),
    sftpConnections: new Map(),
    sshConnections: new Map(),
    sshConnectionPool: new Map(),
    connectionStatus: new Map(),
    KeyboardInteractiveTimeout: 300000,
    handleRequestKeyboardInteractive: vi.fn(),
    getConnectionPoolKey: vi.fn(),
    createProxyCommandSocket: vi.fn()
  }))

  vi.doMock('../sshConfig', () => ({
    getSshKeepaliveConfig: vi.fn(async () => ({ keepaliveInterval: 10000, keepaliveCountMax: 3 }))
  }))

  vi.doMock('../jumpserverHandle', () => ({
    jumpserverConnections: new Map(),
    jumpserverShellStreams: new Map(),
    jumpserverExecStreams: new Map(),
    jumpserverMarkedCommands: new Map(),
    jumpserverConnectionStatus: new Map(),
    jumpserverLastCommand: new Map(),
    createJumpServerExecStream: vi.fn(),
    executeCommandOnJumpServerExec: vi.fn(),
    jumpserverSessionPids: new Map()
  }))

  vi.doMock('../proxy', () => ({
    createProxySocket: vi.fn()
  }))

  vi.doMock('../algorithms', () => ({
    getAlgorithmsByAssetType: vi.fn()
  }))

  vi.doMock('../jumpserver/connectionManager', () => ({
    getPackageInfo: vi.fn(() => ({ name: 'chaterm', version: 'test' }))
  }))

  vi.doMock('@logging/index', () => ({
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }))
  }))

  const mod = await import('../sftpTransfer')
  return mod
}

describe('sftpTransfer backup helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('formatBackupSuffix returns YYYYmmdd-HH24MMSS shape', async () => {
    const { formatBackupSuffix } = await setupModule()
    const d = new Date('2025-07-03T16:30:45')
    expect(formatBackupSuffix(d)).toBe('20250703-163045')
  })

  it('backupRemoteEntity returns undefined when target does not exist', async () => {
    const { backupRemoteEntity } = await setupModule()
    const sftp = createMockSftp()
    const result = await backupRemoteEntity(sftp as any, '/remote/file.txt')
    expect(result).toBeUndefined()
    expect(sftp.rename).not.toHaveBeenCalled()
  })

  it('backupRemoteEntity renames existing file to suffix name', async () => {
    const { backupRemoteEntity } = await setupModule()
    const sftp = createMockSftp({ '/remote/file.txt': { isDirectory: false } })
    const result = await backupRemoteEntity(sftp as any, '/remote/file.txt')

    expect(result).toMatch(/^\/remote\/file\.txt\.\d{8}-\d{6}$/)
    expect(sftp.rename).toHaveBeenCalledTimes(1)
    expect(sftp.rename).toHaveBeenCalledWith('/remote/file.txt', expect.stringMatching(/file\.txt\.\d{8}-\d{6}$/), expect.any(Function))
  })

  it('backupRemoteEntity renames existing directory to suffix name', async () => {
    const { backupRemoteEntity } = await setupModule()
    const sftp = createMockSftp({ '/remote/mydir': { isDirectory: true } })
    const result = await backupRemoteEntity(sftp as any, '/remote/mydir')

    expect(result).toMatch(/^\/remote\/mydir\.\d{8}-\d{6}$/)
    expect(sftp.rename).toHaveBeenCalledTimes(1)
  })

  it('backupRemoteEntity appends counter when backup name already exists', async () => {
    const { backupRemoteEntity, formatBackupSuffix } = await setupModule()
    const suffix = formatBackupSuffix(new Date())
    const existingBackup = `/remote/file.txt.${suffix}`
    const sftp = createMockSftp({
      '/remote/file.txt': { isDirectory: false },
      [existingBackup]: { isDirectory: false }
    })

    const result = await backupRemoteEntity(sftp as any, '/remote/file.txt')

    expect(result).toBe(`/remote/file.txt.${suffix}.1`)
    expect(sftp.rename).toHaveBeenCalledWith('/remote/file.txt', `/remote/file.txt.${suffix}.1`, expect.any(Function))
  })

  it('backupRemoteEntity throws when rename fails', async () => {
    const { backupRemoteEntity } = await setupModule()
    const sftp = createMockSftp({ '/remote/file.txt': { isDirectory: false } })
    sftp.rename.mockImplementation((_from: string, _to: string, cb: (err?: Error | null) => void) => {
      cb(new Error('permission denied'))
    })

    await expect(backupRemoteEntity(sftp as any, '/remote/file.txt')).rejects.toThrow('permission denied')
  })

  it('shouldSkipUploadEntry skips Python bytecode artifacts', async () => {
    const { shouldSkipUploadEntry } = await setupModule()
    expect(shouldSkipUploadEntry('__pycache__', true)).toBe(true)
    expect(shouldSkipUploadEntry('.pytest_cache', true)).toBe(true)
    expect(shouldSkipUploadEntry('module.pyc', false)).toBe(true)
    expect(shouldSkipUploadEntry('module.pyo', false)).toBe(true)
    expect(shouldSkipUploadEntry('module.py', false)).toBe(false)
    expect(shouldSkipUploadEntry('src', true)).toBe(false)
  })
})
