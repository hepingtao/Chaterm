import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { execCommand } from '../connect'

const fakeStream = () => {
  const stream: any = new EventEmitter()
  stream.stderr = new EventEmitter()
  return stream
}

const fakeConn = (stream: any, execErr?: Error) => ({
  exec: (_cmd: string, cb: (err: Error | null, s?: any) => void) => setImmediate(() => cb(execErr ?? null, execErr ? undefined : stream))
})

const collector = () => {
  const chunks: Buffer[] = []
  const writable = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    }
  })
  return { writable, text: () => Buffer.concat(chunks).toString('utf8') }
}

const flush = () => new Promise((r) => setImmediate(r))

describe('execCommand', () => {
  it('streams stdout and stderr and resolves the remote exit code', async () => {
    const stream = fakeStream()
    const out = collector()
    const err = collector()
    const pending = execCommand(fakeConn(stream) as any, 'df -h', { out: out.writable, err: err.writable })
    await flush()
    stream.emit('data', Buffer.from('hello '))
    stream.stderr.emit('data', Buffer.from('oops'))
    stream.emit('close', 0, null)
    const res = await pending
    await flush()
    expect(res).toEqual({ code: 0, signal: null })
    expect(out.text()).toBe('hello ')
    expect(err.text()).toBe('oops')
  })

  it('resolves the remote signal when the command is killed', async () => {
    const stream = fakeStream()
    const pending = execCommand(fakeConn(stream) as any, 'sleep 999', { out: collector().writable, err: collector().writable })
    await flush()
    stream.emit('close', null, 'SIGTERM')
    const res = await pending
    expect(res).toEqual({ code: null, signal: 'SIGTERM' })
  })

  it('rejects when the exec channel cannot be opened', async () => {
    await expect(execCommand(fakeConn(fakeStream(), new Error('channel failed')) as any, 'ls')).rejects.toThrow('channel failed')
  })

  it('rejects when exec returns no stream and no error', async () => {
    await expect(execCommand(fakeConn(null) as any, 'ls')).rejects.toThrow('Failed to open exec channel')
  })
})
