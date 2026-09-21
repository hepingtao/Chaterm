import { describe, expect, it } from 'vitest'
import { deriveSystemName, parseTarget } from '../target'

describe('parseTarget direct targets', () => {
  it('parses user@host with default port 22', () => {
    const t = parseTarget('deploy@10.1.1.5:/var/log')
    expect(t.user).toBe('deploy')
    expect(t.host).toBe('10.1.1.5')
    expect(t.port).toBe(22)
    expect(t.path).toBe('/var/log')
    expect(t.bastion).toBeUndefined()
    expect(t.credUser).toBe('deploy')
    expect(t.credHost).toBe('10.1.1.5')
  })

  it('honors an explicit port flag', () => {
    const t = parseTarget('deploy@10.1.1.5:/x', 2202)
    expect(t.port).toBe(2202)
  })

  it('throws on malformed targets', () => {
    expect(() => parseTarget('bad-target')).toThrow()
    expect(() => parseTarget('@host')).toThrow()
    expect(() => parseTarget('')).toThrow()
  })
})

describe('parseTarget JumpServer compound targets', () => {
  it('parses the full user@system@ip@bastion form with port 2222', () => {
    const t = parseTarget('hepingtao@itouchtv@192.168.31.23@jump.itouchtv.cn:/home/itouchtv')
    expect(t.user).toBe('hepingtao@itouchtv@192.168.31.23')
    expect(t.host).toBe('jump.itouchtv.cn')
    expect(t.port).toBe(2222)
    expect(t.path).toBe('/home/itouchtv')
    expect(t.bastion).toEqual({ loginuser: 'hepingtao', systemName: 'itouchtv', targetIp: '192.168.31.23', host: 'jump.itouchtv.cn' })
    expect(t.credUser).toBe('hepingtao')
    expect(t.credHost).toBe('jump.itouchtv.cn')
  })

  it('derives the system name from a domain bastion in the short form', () => {
    const t = parseTarget('hepingtao@192.168.31.23@jump.itouchtv.cn')
    expect(t.user).toBe('hepingtao@itouchtv@192.168.31.23')
    expect(t.host).toBe('jump.itouchtv.cn')
    expect(t.port).toBe(2222)
  })

  it('keeps an explicit port over the 2222 default', () => {
    const t = parseTarget('hepingtao@itouchtv@192.168.31.23@jump.itouchtv.cn', 2233)
    expect(t.port).toBe(2233)
  })

  it('refuses short form when the system name is not derivable (IP bastion)', () => {
    expect(() => parseTarget('u@10.0.0.1@10.0.0.2')).toThrow(/system name/)
  })

  it('refuses more than three @-segments', () => {
    expect(() => parseTarget('u@s@ip@bastion@extra')).toThrow(/Invalid target/)
  })
})

describe('deriveSystemName', () => {
  it('takes the second-level domain', () => {
    expect(deriveSystemName('jump.itouchtv.cn')).toBe('itouchtv')
  })
  it('returns null for IPs and bare hosts', () => {
    expect(deriveSystemName('10.0.0.1')).toBeNull()
    expect(deriveSystemName('localhost')).toBeNull()
  })
})
