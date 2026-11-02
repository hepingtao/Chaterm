import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi } from 'vitest'

type IpcHandler = (event: any, payload?: any) => any

// A JumpServer shell channel double: records end() calls, invokes write callbacks
// asynchronously like a real ssh2 channel stream.
class FakeJumpServerStream extends EventEmitter {
  public stderr = new EventEmitter()
  public ended = false

  write(_data: unknown, cb?: (err?: Error) => void) {
    if (typeof cb === 'function') setImmediate(() => cb())
    return true
  }

  end() {
    this.ended = true
    this.emit('close')
  }
}

const setupHandlers = async () => {
  vi.resetModules()

  const handlers = new Map<string, IpcHandler>()

  const ipcMainMock = {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler)
    }),
    on: vi.fn(),
    once: vi.fn(),
    removeAllListeners: vi.fn()
  }

  const appMock = { getAppPath: () => process.cwd() }

  vi.doMock('electron', () => ({
    app: appMock,
    ipcMain: ipcMainMock,
    BrowserWindow: {
      fromWebContents: vi.fn(() => ({}))
    },
    dialog: {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn()
    },
    default: {
      app: appMock,
      ipcMain: ipcMainMock
    }
  }))

  // JumpServer session state the ssh:shell handler reads and mutates. The maps
  // are exported so tests can populate sessions that share one bastion connection.
  const jumpserverConnections = new Map<string, any>()
  const jumpserverShellStreams = new Map<string, any>()
  const jumpserverExecStreams = new Map<string, any>()
  const jumpserverMarkedCommands = new Map<string, any>()
  const jumpserverConnectionStatus = new Map<string, any>()
  const jumpserverLastCommand = new Map<string, string>()
  const jumpserverSessionPids = new Map<string, number>()

  vi.doMock('../jumpserverHandle', () => ({
    jumpserverConnections,
    handleJumpServerConnection: vi.fn(),
    jumpserverShellStreams,
    jumpserverExecStreams,
    jumpserverMarkedCommands,
    jumpserverConnectionStatus,
    jumpserverLastCommand,
    createJumpServerExecStream: vi.fn(),
    executeCommandOnJumpServerExec: vi.fn(),
    jumpserverSessionPids
  }))

  vi.doMock('ssh2', () => ({
    Client: vi.fn(function MockClient(this: unknown) {
      const client = new EventEmitter() as EventEmitter & { _sock: { destroyed: boolean } }
      client._sock = { destroyed: false }
      return client
    })
  }))

  vi.doMock('../proxy', () => ({
    createProxySocket: vi.fn()
  }))

  vi.doMock('../jumpserver/errorUtils', () => ({
    buildErrorResponse: vi.fn((error: unknown) => ({
      status: 'error',
      message: error instanceof Error ? error.message : String(error)
    }))
  }))

  vi.doMock('../algorithms', () => ({
    getAlgorithmsByAssetType: vi.fn(() => undefined)
  }))

  vi.doMock('../bastionPlugin', () => ({
    connectBastionByType: vi.fn(async () => null),
    shellBastionSession: vi.fn(async () => null),
    resizeBastionSession: vi.fn(async () => null),
    writeBastionSession: vi.fn(async () => null),
    disconnectBastionSession: vi.fn(async () => null)
  }))

  vi.doMock('../postConnectProbePolicy', () => ({
    shouldSkipPostConnectProbe: vi.fn(() => true)
  }))

  vi.doMock('../sftpTransfer', () => ({
    sftpConnectionInfoMap: new Map()
  }))

  vi.doMock('../ssh-agent/ChatermSSHAgent', () => ({
    SSHAgentManager: {
      getInstance: vi.fn(() => ({
        getAgent: vi.fn(),
        enableAgent: vi.fn(),
        addKey: vi.fn(),
        removeKey: vi.fn(),
        listKeys: vi.fn(() => [])
      }))
    }
  }))

  vi.doMock('@logging/index', () => ({
    createLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    }))
  }))

  const sshHandle = await import('../sshHandle')
  sshHandle.registerSSHHandlers()

  return {
    shellHandler: handlers.get('ssh:shell')!,
    jumpserverConnections,
    jumpserverShellStreams,
    jumpserverLastCommand
  }
}

const flushAsync = () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))

const openSession = async (
  setup: Awaited<ReturnType<typeof setupHandlers>>,
  id: string,
  stream: FakeJumpServerStream,
  event: { sender: { send: ReturnType<typeof vi.fn> } }
) => {
  setup.jumpserverShellStreams.set(id, stream)
  const result = await setup.shellHandler(event as any, { id, terminalType: 'xterm-256color', cols: 80, rows: 24 })
  expect(result).toMatchObject({ status: 'success' })
}

describe('sshHandle JumpServer menu-exit connection release', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the shared bastion connection alive when another session still uses it', async () => {
    const setup = await setupHandlers()
    const event = { sender: { send: vi.fn() } }

    const sharedConn = { end: vi.fn() }
    const streamA = new FakeJumpServerStream()

    // Two terminals to different assets multiplexing one bastion connection;
    // term-b's shell stream lives elsewhere, only the shared conn matters here.
    setup.jumpserverConnections.set('term-a', { conn: sharedConn })
    setup.jumpserverConnections.set('term-b', { conn: sharedConn })

    await openSession(setup, 'term-a', streamA, event)
    setup.jumpserverLastCommand.set('term-a', 'exit')

    streamA.emit('data', Buffer.from('logout\r\n[Host]> '))
    await flushAsync()

    // This session's channel must close, but the shared connection must survive
    expect(streamA.ended).toBe(true)
    expect(sharedConn.end).not.toHaveBeenCalled()
    expect(setup.jumpserverConnections.has('term-b')).toBe(true)
  })

  it('releases the underlying connection when the quitting session is the last one', async () => {
    const setup = await setupHandlers()
    const event = { sender: { send: vi.fn() } }

    const soloConn = { end: vi.fn() }
    const streamA = new FakeJumpServerStream()

    setup.jumpserverConnections.set('term-a', { conn: soloConn })

    await openSession(setup, 'term-a', streamA, event)
    setup.jumpserverLastCommand.set('term-a', 'logout')

    streamA.emit('data', Buffer.from('logout\r\n[Host]> '))
    await flushAsync()

    expect(streamA.ended).toBe(true)
    expect(soloConn.end).toHaveBeenCalledTimes(1)
  })

  it('does not trigger the menu quit when the last command was not an exit command', async () => {
    const setup = await setupHandlers()
    const event = { sender: { send: vi.fn() } }

    const conn = { end: vi.fn() }
    const streamA = new FakeJumpServerStream()
    const writeSpy = vi.spyOn(streamA, 'write')

    setup.jumpserverConnections.set('term-a', { conn })

    await openSession(setup, 'term-a', streamA, event)
    setup.jumpserverLastCommand.set('term-a', 'ls -la')

    streamA.emit('data', Buffer.from('total 0\r\n[Host]> '))
    await flushAsync()

    expect(writeSpy).not.toHaveBeenCalledWith('q\r', expect.any(Function))
    expect(streamA.ended).toBe(false)
    expect(conn.end).not.toHaveBeenCalled()
  })
})
