import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockSftp = {
  readdir: ReturnType<typeof vi.fn>
  stat: ReturnType<typeof vi.fn>
}

const createMockSftp = (entries: Record<string, { mode?: number; size?: number; mtime?: number }> = {}): MockSftp => {
  const normalize = (p: string) => p.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  const store = new Map<string, { mode?: number; size?: number; mtime?: number }>()

  for (const [k, v] of Object.entries(entries)) {
    store.set(normalize(k), v)
  }

  return {
    readdir: vi.fn((rawPath: string, cb: (err?: Error | null, list?: any[]) => void) => {
      const key = normalize(rawPath)
      // Default readdir returns only non-dot entries to simulate JumpServer filtering.
      const list = Array.from(store.entries())
        .filter(([k]) => k.startsWith(key === '/' ? key : key + '/') && k !== key)
        .map(([k, v]) => {
          const name = k.slice((key === '/' ? key : key + '/').length).split('/')[0]
          return {
            filename: name,
            attrs: {
              ...v,
              isDirectory: () => ((v.mode ?? 0) & 0o170000) === 0o040000,
              isSymbolicLink: () => ((v.mode ?? 0) & 0o170000) === 0o120000
            }
          }
        })
        .filter((item, idx, arr) => arr.findIndex((i) => i.filename === item.filename) === idx)
        .filter((item) => !item.filename.startsWith('.'))
      cb(null, list)
    }),
    stat: vi.fn((p: string, cb: (err?: Error | null, st?: any) => void) => {
      const key = normalize(p)
      if (store.has(key)) {
        const entry = store.get(key)!
        cb(null, {
          ...entry,
          isDirectory: () => ((entry.mode ?? 0) & 0o170000) === 0o040000,
          isSymbolicLink: () => ((entry.mode ?? 0) & 0o170000) === 0o120000
        })
      } else {
        cb(Object.assign(new Error('No such file'), { code: 2 }))
      }
    })
  }
}

const createMockConn = (execOutput: string | Error = '') => {
  return {
    exec: vi.fn((_cmd: string, cb: (err?: Error | null, stream?: any) => void) => {
      if (execOutput instanceof Error) {
        cb(execOutput)
        return
      }
      const stream = {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'data') {
            handler(Buffer.from(execOutput))
          }
          if (event === 'close') {
            handler()
          }
        }),
        stderr: {
          on: vi.fn()
        }
      }
      cb(null, stream)
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
  const sshHandle = await import('../sshHandle')
  return { ...mod, sshConnections: sshHandle.sshConnections }
}

describe('sftpTransfer exec fallback helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('execListDirViaSsh parses ls output and excludes . and ..', async () => {
    const { execListDirViaSsh } = await setupModule()
    const conn = createMockConn('..\n.\n.bashrc\n.ssh\nfile1\n')
    const names = await execListDirViaSsh(conn, '/home/user')
    expect(names).toEqual(['.bashrc', '.ssh', 'file1'])
    expect(conn.exec).toHaveBeenCalledWith("ls -a -1 -- '/home/user'", expect.any(Function))
  })

  it('execListDirViaSsh returns empty array when exec errors', async () => {
    const { execListDirViaSsh } = await setupModule()
    const conn = createMockConn(new Error('channel open failed'))
    const names = await execListDirViaSsh(conn, '/home/user')
    expect(names).toEqual([])
  })

  it('wrapSftpAttrs produces directory/link/file helpers', async () => {
    const { wrapSftpAttrs } = await setupModule()
    const dir = wrapSftpAttrs({ mode: 0o040755, size: 0, mtime: 0 })
    expect(dir.isDirectory()).toBe(true)
    expect(dir.isSymbolicLink()).toBe(false)

    const link = wrapSftpAttrs({ mode: 0o120777, size: 0, mtime: 0 })
    expect(link.isSymbolicLink()).toBe(true)

    const file = wrapSftpAttrs({ mode: 0o100644, size: 10, mtime: 0 })
    expect(file.isFile()).toBe(true)
  })

  it('enrichReaddirWithExecFallback adds hidden files missing from readdir', async () => {
    const { enrichReaddirWithExecFallback } = await setupModule()
    const sftp = createMockSftp({
      '/home/user/.bashrc': { mode: 0o100644, size: 100, mtime: 0 },
      '/home/user/file1': { mode: 0o100644, size: 200, mtime: 0 }
    })
    const conn = createMockConn('..\n.\n.bashrc\nfile1\n')
    const list = [{ filename: 'file1', attrs: { isDirectory: () => false, isSymbolicLink: () => false } }]

    const result = await enrichReaddirWithExecFallback(conn, sftp, '/home/user', list)

    expect(result).toHaveLength(2)
    expect(result.map((i) => i.filename).sort()).toEqual(['.bashrc', 'file1'])
    expect(result.find((i) => i.filename === '.bashrc')?.attrs.isFile()).toBe(true)
  })

  it('readSftpDirWithFallback triggers exec when includeHidden is true and readdir has no dot files', async () => {
    const { readSftpDirWithFallback, sshConnections } = await setupModule()
    const sftp = createMockSftp({
      '/home/user/file1': { mode: 0o100644, size: 200, mtime: 0 },
      '/home/user/.bashrc': { mode: 0o100644, size: 100, mtime: 0 }
    })
    const conn = createMockConn('..\n.\n.bashrc\nfile1\n')
    sshConnections.set('user@host:ssh:abc:files-1', conn as any)

    const result = await readSftpDirWithFallback(sftp, '/home/user', 'user@host:ssh:abc:files-1', true)

    expect(conn.exec).toHaveBeenCalled()
    expect(result.map((i) => i.filename).sort()).toEqual(['.bashrc', 'file1'])
  })

  it('readSftpDirWithFallback does not trigger exec without includeHidden even when readdir has no dot files', async () => {
    const { readSftpDirWithFallback, sshConnections } = await setupModule()
    const sftp = createMockSftp({
      '/home/user/file1': { mode: 0o100644, size: 200, mtime: 0 },
      '/home/user/.bashrc': { mode: 0o100644, size: 100, mtime: 0 }
    })
    const conn = createMockConn('..\n.\n.bashrc\nfile1\n')
    sshConnections.set('user@host:ssh:abc:files-1', conn as any)

    const result = await readSftpDirWithFallback(sftp, '/home/user', 'user@host:ssh:abc:files-1')

    expect(conn.exec).not.toHaveBeenCalled()
    expect(result.map((i) => i.filename)).toEqual(['file1'])
  })

  it('readSftpDirWithFallback skips exec when readdir already has dot files', async () => {
    const { readSftpDirWithFallback, sshConnections } = await setupModule()
    const sftp = createMockSftp({
      '/home/user/.bashrc': { mode: 0o100644, size: 100, mtime: 0 }
    })
    sftp.readdir.mockImplementation((_path: string, cb: (err?: Error | null, list?: any[]) => void) => {
      cb(null, [
        {
          filename: '.bashrc',
          attrs: { isDirectory: () => false, isSymbolicLink: () => false }
        }
      ])
    })
    const conn = createMockConn('')
    sshConnections.set('user@host:ssh:abc:files-1', conn as any)

    const result = await readSftpDirWithFallback(sftp, '/home/user', 'user@host:ssh:abc:files-1')

    expect(conn.exec).not.toHaveBeenCalled()
    expect(result.map((i) => i.filename)).toEqual(['.bashrc'])
  })

  it('findSshConnForSftp returns JumpServer owned connection for jumpserver id', async () => {
    const { findSshConnForSftp, sftpOwnedJumpServerConnections } = await setupModule()
    const conn = createMockConn('')
    sftpOwnedJumpServerConnections.set('user@bastion:local:hostbase64:files-1', conn as any)

    const found = findSshConnForSftp('user@bastion:local:hostbase64:files-1')
    expect(found).toBe(conn)
  })

  it('findSshConnForSftp returns standard SSH connection by prefix match', async () => {
    const { findSshConnForSftp, sshConnections } = await setupModule()
    const conn = createMockConn('')
    sshConnections.set('user@host:ssh:abc', conn as any)

    const found = findSshConnForSftp('user@host:ssh:abc:files-1')
    expect(found).toBe(conn)
  })
})
