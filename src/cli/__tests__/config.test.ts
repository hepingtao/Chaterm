import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadCfmConfig, resolveCfmConfigPath } from '../config'

let tmpBase: string
const prevEnv: Record<string, string | undefined> = {}

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-config-test-'))
  for (const key of ['CFM_BASTION', 'CFM_USER', 'XDG_CONFIG_HOME']) {
    prevEnv[key] = process.env[key]
    delete process.env[key]
  }
})

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
  for (const [key, value] of Object.entries(prevEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('loadCfmConfig', () => {
  it('returns empty config when no file or env exists', () => {
    expect(loadCfmConfig({ baseDir: tmpBase })).toEqual({})
  })

  it('reads defaultBastion and defaultUser from config.json', () => {
    const dir = path.join(tmpBase, 'file-only')
    fs.mkdirSync(path.join(dir, 'cfm'), { recursive: true })
    fs.writeFileSync(resolveCfmConfigPath(dir), JSON.stringify({ defaultBastion: 'jump.example.cn', defaultUser: 'bob' }))
    expect(loadCfmConfig({ baseDir: dir })).toEqual({ defaultBastion: 'jump.example.cn', defaultUser: 'bob' })
  })

  it('lets env variables override the file', () => {
    const dir = path.join(tmpBase, 'env-wins')
    fs.mkdirSync(path.join(dir, 'cfm'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cfm', 'config.json'), JSON.stringify({ defaultBastion: 'file.example.cn', defaultUser: 'fileuser' }))
    process.env.CFM_BASTION = 'env.example.cn'
    try {
      expect(loadCfmConfig({ baseDir: dir })).toEqual({ defaultBastion: 'env.example.cn', defaultUser: 'fileuser' })
    } finally {
      delete process.env.CFM_BASTION
    }
  })

  it('ignores a malformed config file', () => {
    const dir = path.join(tmpBase, 'malformed')
    fs.mkdirSync(path.join(dir, 'cfm'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'cfm', 'config.json'), '{not json')
    expect(loadCfmConfig({ baseDir: dir })).toEqual({})
  })
})
