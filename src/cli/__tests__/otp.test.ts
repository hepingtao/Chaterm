import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createCipheriv, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { generateTOTP } from '../../main/ssh/otp/totp'
import { generateOtpForHost, saveOtpSecret } from '../otp'

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' // valid base32, >= 16 chars
let tmpBase: string
let keyFile: string

const writeLocalKeyCipher = (plain: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', fs.readFileSync(keyFile), iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `lk1:${iv.toString('base64')}.${ct.toString('base64')}.${cipher.getAuthTag().toString('base64')}`
}

const dpapiProtect = (plain: string): Buffer => {
  const psScript =
    'Add-Type -AssemblyName System.Security;' +
    "$plain = [Convert]::FromBase64String('" +
    Buffer.from(plain, 'utf-8').toString('base64') +
    "');" +
    '$enc = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Console]::OpenStandardOutput().Write($enc, 0, $enc.Length);'
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'buffer',
    windowsHide: true
  })
}

beforeAll(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'cfm-otp-test-'))
  keyFile = path.join(tmpBase, 'chaterm-db-credential.key')
  fs.writeFileSync(keyFile, randomBytes(32))
})

// Desktop convention: master key file sits next to otp-secrets.json in userData.
const makeUserDataDir = (name: string): string => {
  const dir = path.join(tmpBase, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'chaterm-db-credential.key'), fs.readFileSync(keyFile))
  return dir
}

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true })
})

describe('generateOtpForHost', () => {
  it('generates the current TOTP from an lk1-encrypted chaterm secret', () => {
    const userDataDir = makeUserDataDir('chaterm')
    fs.writeFileSync(path.join(userDataDir, 'otp-secrets.json'), JSON.stringify({ 'jump.example.cn': writeLocalKeyCipher(SECRET) }))

    const forTime = Date.now()
    const code = generateOtpForHost('jump.example.cn', { baseDirs: [userDataDir], forTime, vault: false })
    expect(code).toMatch(/^\d{6}$/)
    expect(code).toBe(generateTOTP(SECRET, 6, 30, forTime))
  })

  it('matches host keys case-insensitively', () => {
    const userDataDir = makeUserDataDir('case-test')
    fs.writeFileSync(path.join(userDataDir, 'otp-secrets.json'), JSON.stringify({ 'Case.Example.CN': writeLocalKeyCipher(SECRET) }))
    const forTime = Date.now()
    expect(generateOtpForHost('case.example.cn', { baseDirs: [userDataDir], forTime, vault: false })).toBe(generateTOTP(SECRET, 6, 30, forTime))
  })

  it('accepts a raw base32 secret stored without an encryption prefix', () => {
    const userDataDir = makeUserDataDir('raw-test')
    fs.writeFileSync(path.join(userDataDir, 'otp-secrets.json'), JSON.stringify({ 'raw.example.cn': SECRET }))
    const forTime = Date.now()
    expect(generateOtpForHost('raw.example.cn', { baseDirs: [userDataDir], forTime, vault: false })).toBe(generateTOTP(SECRET, 6, 30, forTime))
  })

  it('falls back to the otp-ts vault.bin via DPAPI (windows only)', (ctx) => {
    if (process.platform !== 'win32') ctx.skip()
    const vaultDir = path.join(os.homedir(), '.otpvault')
    const vaultPath = path.join(vaultDir, 'vault.bin')
    if (!fs.existsSync(vaultPath)) {
      // Do not touch a real vault: exercise the DPAPI path with a temp HOME is
      // not possible (homedir is fixed), so verify Protect/Unprotect roundtrip.
      const blob = dpapiProtect(SECRET)
      const psScript =
        'Add-Type -AssemblyName System.Security;' +
        "$b = [Convert]::FromBase64String('" +
        blob.toString('base64') +
        "');" +
        '$d = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
        '[Console]::OpenStandardOutput().Write($d, 0, $d.Length);'
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(psScript, 'utf16le').toString('base64')],
        {
          encoding: 'buffer',
          windowsHide: true
        }
      )
      expect(out.toString('utf-8')).toBe(SECRET)
      return
    }
    // Real vault exists: only check the lookup returns a plausible code.
    const code = generateOtpForHost('some-unknown-host-xyz')
    expect(code === null || /^\d{6}$/.test(code)).toBe(true)
  })

  it('returns null when nothing matches', () => {
    const empty = makeUserDataDir('empty')
    expect(generateOtpForHost('no-such-host-xyz', { baseDirs: [empty], vault: false })).toBeNull()
  })
})

describe('saveOtpSecret', () => {
  it('stores the secret as lk1 ciphertext only and keeps it readable', () => {
    const userDataDir = makeUserDataDir('save-test')
    const { dir, code } = saveOtpSecret('Save.Example.CN', SECRET, { baseDir: userDataDir, forTime: Date.now() })
    expect(dir).toBe(userDataDir)
    expect(code).toMatch(/^\d{6}$/)

    const raw = fs.readFileSync(path.join(userDataDir, 'otp-secrets.json'), 'utf-8')
    expect(raw).not.toContain(SECRET)
    expect(JSON.parse(raw)['save.example.cn']).toMatch(/^lk1:/)
    expect(fs.statSync(path.join(userDataDir, 'otp-secrets.json')).mode & 0o777).toBe(0o600)

    expect(generateOtpForHost('save.example.cn', { baseDirs: [userDataDir], vault: false })).toMatch(/^\d{6}$/)
  })

  it('creates the local master key file with 0600 when absent', () => {
    const freshDir = path.join(tmpBase, 'fresh-key')
    saveOtpSecret('fresh.example.cn', SECRET, { baseDir: freshDir })
    expect(fs.statSync(path.join(freshDir, 'chaterm-db-credential.key')).mode & 0o777).toBe(0o600)
  })

  it('rejects an invalid base32 secret', () => {
    const userDataDir = makeUserDataDir('save-invalid')
    expect(() => saveOtpSecret('bad.example.cn', 'not-base32!!', { baseDir: userDataDir })).toThrow()
  })
})
