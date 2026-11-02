// Read-only lookup of SSH asset credentials stored by the Chaterm desktop app.
//
// The desktop app keeps SSH assets (host/port/username/password, or a keyBased
// auth chain with a PEM private key) in a local SQLite database:
//   <userData>/chaterm_db/<userId>/chaterm_data.db   (also legacy flat layout)
//
// The CLI never writes to these databases and never logs secret material.
// SQLite access uses sql.js (pure WASM) so the pkg single-binary build does not
// need a native module rebuilt against the Node ABI.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import initSqlJs from 'sql.js'

export interface StoredCredential {
  username: string
  host: string
  port: number
  authType: string | null
  password: string | null
  privateKey: string | null
  passphrase: string | null
  source: string
}

export interface FindCredentialOptions {
  username: string
  host: string
  port: number
  /** Overrides the Chaterm userData base directory (defaults to env/OS paths). */
  baseDir?: string
}

// Matches the desktop edition layout: cn -> 'chaterm', global -> 'chaterm-global'.
const DEFAULT_EDITION_DIRS = ['chaterm', 'chaterm-global']

const platformConfigBase = (): string => {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support')
  }
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
}

// Candidate userData base directories, most relevant first.
export const resolveChatermBaseDirs = (overrideDir?: string): string[] => {
  const custom = overrideDir || process.env.CHATERM_USER_DATA
  if (custom) return [custom]
  return DEFAULT_EDITION_DIRS.map((d) => path.join(platformConfigBase(), d))
}

// Enumerate candidate chaterm_data.db files. Numeric user dirs sort before the
// local-mode pseudo user (999999999) so logged-in users win deterministically.
export const resolveCandidateDbPaths = (baseDirs: string[]): string[] => {
  const out: string[] = []
  for (const base of baseDirs) {
    const dbRoot = path.join(base, 'chaterm_db')
    if (!fs.existsSync(dbRoot)) continue

    let entries: string[] = []
    try {
      entries = fs.readdirSync(dbRoot)
    } catch {
      continue
    }
    const userDirs = entries
      .filter((e) => /^\d+$/.test(e))
      .sort((a, b) => Number(a) - Number(b))
      .map((e) => path.join(dbRoot, e, 'chaterm_data.db'))

    const legacy = path.join(dbRoot, 'chaterm_data.db')
    for (const p of [...userDirs, legacy]) {
      if (fs.existsSync(p)) out.push(p)
    }
  }
  return out
}

// Copy db + WAL sidecars so a live desktop app or torn read cannot corrupt the
// in-memory snapshot. Returns the path of the temporary copy.
const snapshotDb = (dbPath: string): string => {
  const tmpDir = path.join(os.tmpdir(), `cfm-db-${randomBytes(6).toString('hex')}`)
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmpDb = path.join(tmpDir, 'chaterm_data.db')
  fs.copyFileSync(dbPath, tmpDb)
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix
    if (fs.existsSync(side)) {
      try {
        fs.copyFileSync(side, tmpDb + suffix)
      } catch {
        // sidecar may vanish between existsSync and copy — the main file is enough
      }
    }
  }
  return tmpDb
}

const cleanupSnapshot = (tmpDb: string) => {
  try {
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true })
  } catch {
    // best effort
  }
}

interface AssetRow {
  username: string
  asset_ip: string
  port: number | null
  auth_type: string | null
  password: string | null
  key_chain_id: number | null
  chain_private_key: string | null
  chain_passphrase: string | null
}

const queryAsset = (db: any, username: string, host: string, port: number): AssetRow | null => {
  const stmt = db.prepare(`
    SELECT a.username, a.asset_ip, a.port, a.auth_type, a.password, a.key_chain_id,
           c.chain_private_key AS chain_private_key, c.passphrase AS chain_passphrase
    FROM t_assets a
    LEFT JOIN t_asset_chains c ON a.key_chain_id = c.key_chain_id
  `)
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject() as AssetRow
      if (String(row.username || '') === username && String(row.asset_ip || '').toLowerCase() === host.toLowerCase() && (row.port ?? 22) === port) {
        return row
      }
    }
  } finally {
    stmt.free()
  }
  return null
}

const toCredential = (row: AssetRow, source: string): StoredCredential => {
  const authType = row.auth_type || null
  if (authType === 'keyBased') {
    return {
      username: row.username,
      host: row.asset_ip,
      port: row.port ?? 22,
      authType,
      password: null,
      privateKey: row.chain_private_key || null,
      passphrase: row.chain_passphrase || null,
      source
    }
  }
  return {
    username: row.username,
    host: row.asset_ip,
    port: row.port ?? 22,
    authType,
    password: row.password || null,
    privateKey: null,
    passphrase: null,
    source
  }
}

let sqlJsInit: Promise<any> | null = null

// In the esbuild bundle the .wasm import is inlined as a data URL
// (--loader:.wasm=dataurl), so the pkg single binary needs no asset lookup.
// Under plain tsc/node the require fails and sql.js falls back to locating
// sql-wasm.wasm inside node_modules.
const loadWasmBinary = (): ArrayBuffer | undefined => {
  try {
    const dataUrl: string = require('sql.js/dist/sql-wasm.wasm')
    const base64 = String(dataUrl).split(',')[1] || ''
    if (!base64) return undefined
    const buf = Buffer.from(base64, 'base64')
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  } catch {
    return undefined
  }
}

const getSqlJs = async (): Promise<any> => {
  if (!sqlJsInit) {
    sqlJsInit = initSqlJs({ wasmBinary: loadWasmBinary() } as any)
  }
  return sqlJsInit
}

/**
 * Look up a stored SSH credential for user@host:port across the local Chaterm
 * desktop databases. Returns null when nothing matches (caller falls back to
 * explicit flags / error).
 */
export const findStoredCredential = async (opts: FindCredentialOptions): Promise<StoredCredential | null> => {
  const candidates = resolveCandidateDbPaths(resolveChatermBaseDirs(opts.baseDir))
  if (candidates.length === 0) return null

  const SQL = await getSqlJs()

  for (const dbPath of candidates) {
    let tmpDb: string | null = null
    try {
      tmpDb = snapshotDb(dbPath)
      const fileBuffer = fs.readFileSync(tmpDb)
      const db = new SQL.Database(fileBuffer)
      try {
        const row = queryAsset(db, opts.username, opts.host, opts.port)
        if (row) return toCredential(row, dbPath)
      } finally {
        db.close()
      }
    } catch {
      // unreadable/foreign db — try the next candidate
    } finally {
      if (tmpDb) cleanupSnapshot(tmpDb)
    }
  }
  return null
}
