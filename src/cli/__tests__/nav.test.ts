import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Writable } from 'node:stream'
import { navExec, parseAccountTable, SENTINEL } from '../nav'

const ACCOUNT_TABLE = [
  '  ID    | 名称                    | 用户名        ',
  '--------+-------------------------+--------------',
  '  1     | 测试linux普通-账号模版  | itouchtv      ',
  '  2     | 测试linux超管-账号模版  | root          ',
  '提示：输入资产[A100(10.0.0.5)]的账号ID',
  'ID> '
].join('\n')

const fakeStream = () => {
  const stream: any = new EventEmitter()
  stream.stderr = new EventEmitter()
  stream.writes = [] as string[]
  stream.write = (data: any) => {
    stream.writes.push(String(data))
    return true
  }
  stream.end = () => {
    stream.ended = true
  }
  return stream
}

const fakeConn = (stream: any) => ({ shell: (cb: any) => setImmediate(() => cb(null, stream)) })

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

interface Fixture {
  stream: any
  out: ReturnType<typeof collector>
  err: ReturnType<typeof collector>
  prompts: string[]
  run: (overrides?: Partial<Parameters<typeof navExec>[1]>) => Promise<number>
}

const setup = (promptAnswer = 'prompted-secret'): Fixture => {
  const stream = fakeStream()
  const out = collector()
  const err = collector()
  const prompts: string[] = []
  const base = {
    targetIp: '10.0.0.5',
    command: 'uptime',
    readyDelayMs: 1,
    out: out.writable,
    err: err.writable,
    promptHidden: async (text: string) => {
      prompts.push(text)
      return promptAnswer
    }
  }
  const run = (overrides: Partial<any> = {}) => navExec(fakeConn(stream) as any, { ...base, ...overrides } as any)
  return { stream, out, err, prompts, run }
}

const flush = () => new Promise((r) => setImmediate(r))
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('navExec', () => {
  it('waits for Opt>, enters the target IP, injects the command and recovers the exit code', async () => {
    const f = setup()
    const pending = f.run()
    await flush()
    f.stream.emit('data', Buffer.from('Tips: 输入 ID 直接登录\r\nOpt>'))
    await flush()
    expect(f.stream.writes[0]).toBe('10.0.0.5\r')

    f.stream.emit('data', Buffer.from('Last login: Mon Jan 1 00:00:00 2026\r\n'))
    await delay(15)
    expect(f.stream.writes[1]).toContain('uptime')
    expect(f.stream.writes[1]).toContain(`echo ${SENTINEL}=$?`)

    f.stream.emit('data', Buffer.from(`up 1 day\n${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
    expect(f.out.text()).not.toContain(SENTINEL)
    expect(f.out.text()).toContain('up 1 day')
  })

  it('prepends cd for a target path', async () => {
    const f = setup()
    const pending = f.run({ targetPath: '/var/log x' })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from('Last login: now\r\n'))
    await delay(15)
    expect(f.stream.writes[1]).toContain(`cd '/var/log x' 2>/dev/null; uptime`)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=5\r\n`))
    await expect(pending).resolves.toBe(5)
  })

  it('answers the asset credential prompt from the stored credential', async () => {
    const f = setup()
    const pending = f.run({ targetCredential: 'stored-pass' })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from('Password: '))
    await flush()
    expect(f.stream.writes[1]).toBe('stored-pass\r')
    f.stream.emit('data', Buffer.from('Last login: now\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
    expect(f.prompts).toHaveLength(0)
  })

  it('asks with a hidden prompt when no stored credential exists', async () => {
    const f = setup('typed-pass')
    const pending = f.run()
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from('密码: '))
    await flush()
    expect(f.stream.writes[1]).toBe('typed-pass\r')
    expect(f.prompts[0]).toContain('10.0.0.5')
    f.stream.emit('data', Buffer.from('Last login: now\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
  })

  it('handles the ID> account selection prompt', async () => {
    const f = setup('2')
    const pending = f.run()
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(f.stream.writes[1]).toBe('2\r')
    expect(f.err.text()).toContain('超管')
    f.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=3\r\n`))
    await expect(pending).resolves.toBe(3)
  })

  it('auto-selects the account matching preferredAccountUser without prompting', async () => {
    const f = setup('9')
    const pending = f.run({ preferredAccountUser: 'itouchtv', verbose: true })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(f.stream.writes[1]).toBe('1\r')
    expect(f.prompts).toHaveLength(0)
    expect(f.err.text()).toContain('auto-selecting account 1 (itouchtv)')
    f.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
  })

  it('hides the navigation trace by default and only streams command output', async () => {
    const f = setup('9')
    const pending = f.run({ preferredAccountUser: 'itouchtv' })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(f.stream.writes[1]).toBe('1\r')
    expect(f.out.text()).toBe('')
    expect(f.err.text()).toBe('')
    f.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`up 1 day\n${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
    expect(f.out.text()).not.toContain('Connecting to')
    expect(f.out.text()).toContain('up 1 day')
  })

  it('prefers the explicit --account by ID, then username, over the system-name match', async () => {
    const f = setup('9')
    const pending = f.run({ preferredAccountUser: 'itouchtv', preferredAccount: '2' })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(f.stream.writes[1]).toBe('2\r')
    expect(f.prompts).toHaveLength(0)
    f.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)

    const g = setup('9')
    const pending2 = g.run({ preferredAccountUser: 'nobody', preferredAccount: 'root' })
    await flush()
    g.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    g.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(g.stream.writes[1]).toBe('2\r')
    g.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    g.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending2).resolves.toBe(0)
  })

  it('falls back to the interactive prompt when no account matches', async () => {
    const f = setup('2')
    const pending = f.run({ preferredAccountUser: 'someone-else' })
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from(ACCOUNT_TABLE))
    await flush()
    expect(f.stream.writes[1]).toBe('2\r')
    expect(f.prompts[0]).toContain('account ID')
    f.stream.emit('data', Buffer.from('Connecting to 10.0.0.5:22\r\n'))
    await delay(15)
    f.stream.emit('data', Buffer.from(`${SENTINEL}=0\r\n`))
    await expect(pending).resolves.toBe(0)
  })

  it('parses the account table rows', () => {
    expect(parseAccountTable(ACCOUNT_TABLE)).toEqual([
      { id: '1', name: '测试linux普通-账号模版', username: 'itouchtv' },
      { id: '2', name: '测试linux超管-账号模版', username: 'root' }
    ])
  })

  it('fails on the [Host]> error state', async () => {
    const f = setup()
    const pending = f.run()
    await flush()
    f.stream.emit('data', Buffer.from('Opt>'))
    await flush()
    f.stream.emit('data', Buffer.from('permission denied\r\n[Host]>'))
    await expect(pending).rejects.toThrow(/\[Host\]>/)
  })

  it('fails when the account has no assets', async () => {
    const f = setup()
    const pending = f.run()
    await flush()
    f.stream.emit('data', Buffer.from('没有资产\r\n'))
    await expect(pending).rejects.toThrow(/no assets for this account/)
  })

  it('fails when the session closes before reaching the target shell', async () => {
    const f = setup()
    const pending = f.run()
    await flush()
    f.stream.emit('close')
    await expect(pending).rejects.toThrow(/closed before the target shell/)
  })

  it('times out when the menu prompt never appears', async () => {
    const f = setup()
    await expect(f.run({ timeoutMs: 30 })).rejects.toThrow(/timed out/)
  })
})
