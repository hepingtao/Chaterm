import { describe, it, expect } from 'vitest'
import { hasNoAssetsPrompt, hasPasswordPrompt, detectDirectConnectionReason } from '../navigator'

describe('hasNoAssetsPrompt', () => {
  it('detects english message', () => {
    expect(hasNoAssetsPrompt('No Assets')).toBe(true)
    expect(hasNoAssetsPrompt('no assets found')).toBe(true)
  })

  it('detects chinese message', () => {
    expect(hasNoAssetsPrompt('没有资产')).toBe(true)
  })

  it('detects japanese message', () => {
    expect(hasNoAssetsPrompt('資産なし')).toBe(true)
  })

  it('detects korean message', () => {
    expect(hasNoAssetsPrompt('자산이 없습니다')).toBe(true)
  })

  it('returns false for unrelated text', () => {
    expect(hasNoAssetsPrompt('Assets list loaded')).toBe(false)
  })
})

describe('hasPasswordPrompt', () => {
  it('detects Password: prompt', () => {
    expect(hasPasswordPrompt('Password:')).toBe(true)
  })

  it('detects password: prompt (lowercase)', () => {
    expect(hasPasswordPrompt('password:')).toBe(true)
  })

  it('detects passphrase: prompt', () => {
    expect(hasPasswordPrompt('passphrase:')).toBe(true)
  })

  it('detects Passphrase: prompt (uppercase)', () => {
    expect(hasPasswordPrompt('Passphrase:')).toBe(true)
  })

  it('detects Chinese 密码: prompt', () => {
    expect(hasPasswordPrompt('密码:')).toBe(true)
  })

  it('detects Chinese 口令: prompt', () => {
    expect(hasPasswordPrompt('口令:')).toBe(true)
  })

  it('returns false for unrelated text', () => {
    expect(hasPasswordPrompt('Enter your name:')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(hasPasswordPrompt('PASSWORD:')).toBe(true)
    expect(hasPasswordPrompt('PASSPHRASE:')).toBe(true)
  })
})

describe('detectDirectConnectionReason', () => {
  it('returns null for empty text', () => {
    expect(detectDirectConnectionReason('')).toBeNull()
  })

  it('detects "Connecting to" indicator', () => {
    expect(detectDirectConnectionReason('Connecting to 192.168.1.100:22')).toBeTruthy()
    expect(detectDirectConnectionReason('Connecting to 192.168.1.100:22')).toContain('Connecting to')
  })

  it('detects Chinese "连接到" indicator', () => {
    expect(detectDirectConnectionReason('连接到 192.168.1.100:22')).toBeTruthy()
    expect(detectDirectConnectionReason('连接到 192.168.1.100:22')).toContain('连接到')
  })

  it('detects "Last login:" indicator', () => {
    expect(detectDirectConnectionReason('Last login: Mon Jan  1 10:00:00 2026')).toBeTruthy()
    expect(detectDirectConnectionReason('Last login: Mon Jan  1 10:00:00 2026')).toContain('Last login:')
  })

  it('detects "Last failed login:" indicator', () => {
    expect(detectDirectConnectionReason('Last failed login: Mon Jan  1 09:00:00 2026')).toBeTruthy()
    expect(detectDirectConnectionReason('Last failed login: Mon Jan  1 09:00:00 2026')).toContain('Last failed login:')
  })

  it('detects "Welcome to" indicator', () => {
    expect(detectDirectConnectionReason('Welcome to Ubuntu 22.04')).toBeTruthy()
    expect(detectDirectConnectionReason('Welcome to Ubuntu 22.04')).toContain('Welcome to')
  })

  it('detects Chinese "欢迎" indicator', () => {
    expect(detectDirectConnectionReason('欢迎登录系统')).toBeTruthy()
    expect(detectDirectConnectionReason('欢迎登录系统')).toContain('欢迎')
  })

  it('detects "Authentication successful" indicator', () => {
    expect(detectDirectConnectionReason('Authentication successful')).toBeTruthy()
    expect(detectDirectConnectionReason('Authentication successful')).toContain('Authentication successful')
  })

  it('detects shell prompt with @ and $', () => {
    const result = detectDirectConnectionReason('user@host:~$')
    expect(result).toBeTruthy()
    expect(result).toContain('Prompt')
  })

  it('detects shell prompt with @ and #', () => {
    const result = detectDirectConnectionReason('root@server:~#')
    expect(result).toBeTruthy()
    expect(result).toContain('Prompt')
  })

  it('detects shell prompt with ]$', () => {
    const result = detectDirectConnectionReason('[user@host ~]$')
    expect(result).toBeTruthy()
    expect(result).toContain('Prompt')
  })

  it('detects shell prompt with ]#', () => {
    const result = detectDirectConnectionReason('[root@host ~]#')
    expect(result).toBeTruthy()
    expect(result).toContain('Prompt')
  })

  it('detects shell prompt with >$', () => {
    const result = detectDirectConnectionReason('user@host:~>$')
    expect(result).toBeTruthy()
    expect(result).toContain('Prompt')
  })

  it('ignores [Host]> prompt', () => {
    expect(detectDirectConnectionReason('[Host]>')).toBeNull()
  })

  it('ignores Opt> prompt', () => {
    expect(detectDirectConnectionReason('1> Opt>')).toBeNull()
  })

  it('returns null for non-matching text', () => {
    expect(detectDirectConnectionReason('Some random output')).toBeNull()
    expect(detectDirectConnectionReason('Loading...')).toBeNull()
  })

  it('detects prompt from multi-line output', () => {
    const output = 'Connecting to 192.168.1.100:22\nLast login: Mon Jan 1 10:00:00 2026\nuser@server:~$'
    const result = detectDirectConnectionReason(output)
    // Should match the first indicator found
    expect(result).toBeTruthy()
  })
})
