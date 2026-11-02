import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import initSqlJs from 'sql.js'
import { findStoredCredential, resolveCandidateDbPaths, resolveChatermBaseDirs } from '../assets-store'

let SQL: any
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-assets-test-'))

const writeUserDb = (userId: string, rows: { chain?: boolean; password?: boolean; legacy?: boolean }) => {
  const userDir = legacyDirName(userId)
  fs.mkdirSync(userDir, { recursive: true })
  const db = new SQL.Database()
  db.exec(`
    CREATE TABLE t_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_ip TEXT, port INTEGER, username TEXT, password TEXT,
      auth_type TEXT, key_chain_id INTEGER, asset_type TEXT
    );
    CREATE TABLE t_asset_chains (
      key_chain_id INTEGER PRIMARY KEY, chain_private_key TEXT, passphrase TEXT, chain_type TEXT
    );
  `)
  if (rows.password) {
    db.run("INSERT INTO t_assets (asset_ip, port, username, password, auth_type) VALUES ('10.1.1.5', 22, 'deploy', 'secret-pass', 'password')")
  }
  if (rows.chain) {
    db.run(
      "INSERT INTO t_asset_chains (key_chain_id, chain_private_key, passphrase, chain_type) VALUES (1, '-----BEGIN OPENSSH PRIVATE KEY-----TEST-----END-----', 'kphrase', 'RSA')"
    )
    db.run("INSERT INTO t_assets (asset_ip, port, username, auth_type, key_chain_id) VALUES ('10.1.1.9', 2222, 'itouchtv', 'keyBased', 1)")
  }
  const data = db.export()
  fs.writeFileSync(path.join(userDir, 'chaterm_data.db'), Buffer.from(data))
  db.close()
}

// 'legacy' puts the db directly under chaterm_db/ (pre-multi-user layout)
const legacyDirName = (userId: string) => (userId === 'legacy' ? path.join(tmpBase, 'chaterm_db') : path.join(tmpBase, 'chaterm_db', userId))

beforeAll(async () => {
  SQL = await initSqlJs()
  writeUserDb('42', { password: true })
  writeUserDb('100', { chain: true })
  writeUserDb('legacy', { password: true })
})

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('resolveChatermBaseDirs', () => {
  it('honors CHATERM_USER_DATA override', () => {
    const prev = process.env.CHATERM_USER_DATA
    process.env.CHATERM_USER_DATA = '/custom/data'
    try {
      expect(resolveChatermBaseDirs()).toEqual(['/custom/data'])
    } finally {
      if (prev === undefined) delete process.env.CHATERM_USER_DATA
      else process.env.CHATERM_USER_DATA = prev
    }
  })

  it('defaults to both edition dirs', () => {
    const prev = process.env.CHATERM_USER_DATA
    delete process.env.CHATERM_USER_DATA
    try {
      const dirs = resolveChatermBaseDirs()
      expect(dirs.length).toBe(2)
      expect(dirs[0].endsWith('chaterm')).toBe(true)
      expect(dirs[1].endsWith('chaterm-global')).toBe(true)
    } finally {
      if (prev !== undefined) process.env.CHATERM_USER_DATA = prev
    }
  })
})

describe('resolveCandidateDbPaths', () => {
  it('lists per-user dbs before the legacy flat layout', () => {
    const candidates = resolveCandidateDbPaths([tmpBase])
    expect(candidates).toHaveLength(3)
    expect(path.basename(path.dirname(candidates[0]))).toBe('42')
    expect(path.basename(path.dirname(candidates[1]))).toBe('100')
    expect(candidates[2]).toBe(path.join(tmpBase, 'chaterm_db', 'chaterm_data.db'))
  })
})

describe('findStoredCredential', () => {
  it('finds a password credential by user@host:port', async () => {
    const cred = await findStoredCredential({ username: 'deploy', host: '10.1.1.5', port: 22, baseDir: tmpBase })
    expect(cred).not.toBeNull()
    expect(cred!.password).toBe('secret-pass')
    expect(cred!.privateKey).toBeNull()
  })

  it('is case-insensitive on host and tolerant of missing port', async () => {
    const cred = await findStoredCredential({ username: 'deploy', host: '10.1.1.5', port: 22, baseDir: tmpBase })
    expect(cred).not.toBeNull()
  })

  it('finds keyBased credentials with private key and passphrase', async () => {
    const cred = await findStoredCredential({ username: 'itouchtv', host: '10.1.1.9', port: 2222, baseDir: tmpBase })
    expect(cred).not.toBeNull()
    expect(cred!.privateKey).toContain('OPENSSH PRIVATE KEY')
    expect(cred!.passphrase).toBe('kphrase')
    expect(cred!.password).toBeNull()
  })

  it('returns null for unknown targets', async () => {
    const cred = await findStoredCredential({ username: 'nobody', host: '10.9.9.9', port: 22, baseDir: tmpBase })
    expect(cred).toBeNull()
  })
})
