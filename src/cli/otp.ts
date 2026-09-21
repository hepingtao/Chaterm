// CLI-side reuse of the desktop OTP auto-fill capability.
//
// Mirrors src/main/ssh/otp/*: read the TOTP secret for a host from the
// Chaterm desktop stores and generate the current code:
//   1. <userData>/otp-secrets.json  — secrets encrypted by the desktop
//      CredentialStore: `ss1:` (Electron safeStorage; on Windows a DPAPI
//      CurrentUser blob) or `lk1:` (AES-256-GCM, master key in
//      <userData>/chaterm-db-credential.key)
//   2. ~/.otpvault/vault.bin — the otp-ts vault (DPAPI-encrypted JSON)
//
// DPAPI blobs are decrypted by shelling out to PowerShell, the same technique
// the desktop uses for vault.bin. No secret material is ever logged.

import { createDecipheriv } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { generateTOTP } from '../main/ssh/otp/totp'
import { resolveChatermBaseDirs } from './assets-store'

const OTP_SECRETS_FILE = 'otp-secrets.json'
const LOCAL_KEY_FILE = 'chaterm-db-credential.key'
const SS1_PREFIX = 'ss1:'
const LK1_PREFIX = 'lk1:'

// DPAPI CurrentUser blob decrypt (Windows only). PowerShell handles the .NET
// ProtectedData call; EncodedCommand avoids quoting issues. Child stderr is
// captured so PowerShell's CLIXML progress noise never reaches the user.
const dpapiDecrypt = (data: Buffer): Buffer => {
  const b64 = data.toString('base64')
  const psScript =
    '$ProgressPreference = "SilentlyContinue";' +
    'Add-Type -AssemblyName System.Security;' +
    "$bytes = [Convert]::FromBase64String('" +
    b64 +
    "');" +
    '$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Console]::OpenStandardOutput().Write($decrypted, 0, $decrypted.Length);'
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'buffer',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e: any) {
    const stderr = e?.stderr ? Buffer.from(e.stderr).toString('utf-8').slice(0, 300) : ''
    throw new Error(`DPAPI decrypt failed: ${e?.message || e}${stderr ? ' — ' + stderr : ''}`)
  }
}

// Decrypt an `lk1:` ciphertext with the desktop's local master key file.
const decryptLocalKeyCipher = (cipher: string, userDataDir: string): string => {
  const keyPath = join(userDataDir, LOCAL_KEY_FILE)
  if (!existsSync(keyPath)) throw new Error(`local key file missing: ${keyPath}`)
  const key = readFileSync(keyPath)
  if (key.length !== 32) throw new Error('local key file malformed')
  const body = cipher.slice(LK1_PREFIX.length)
  const [ivB64, ctB64, tagB64] = body.split('.')
  if (!ivB64 || !ctB64 || !tagB64) throw new Error('malformed local-key ciphertext')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8')
}

// Decrypt an `ss1:` ciphertext. On Windows Electron safeStorage output is a
// DPAPI CurrentUser blob, decryptable via PowerShell. Other platforms are not
// supported here and surface as a decryption failure.
const decryptSafeStorageCipher = (cipher: string): string => {
  if (process.platform !== 'win32') throw new Error('safeStorage OTP secrets are only decryptable on Windows')
  const blob = Buffer.from(cipher.slice(SS1_PREFIX.length), 'base64')
  return dpapiDecrypt(blob).toString('utf8')
}

// otp-secrets.json: { "<host>": "<ss1:...|lk1:...>" }
const readChatermOtpSecret = (hostKey: string, baseDirs: string[]): string | null => {
  for (const base of baseDirs) {
    const filePath = join(base, OTP_SECRETS_FILE)
    if (!existsSync(filePath)) continue
    try {
      const map = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, string>
      // The desktop lowercases keys on write; match case-insensitively anyway
      // to tolerate hand-edited or legacy files.
      const matchedKey = Object.keys(map).find((k) => k.trim().toLowerCase() === hostKey)
      const encrypted = matchedKey ? map[matchedKey] : undefined
      if (!encrypted) continue
      if (encrypted.startsWith(SS1_PREFIX)) return decryptSafeStorageCipher(encrypted)
      if (encrypted.startsWith(LK1_PREFIX)) return decryptLocalKeyCipher(encrypted, base)
    } catch {
      // unreadable / undecryptable entry — try the next store
    }
  }
  return null
}

// ~/.otpvault/vault.bin fallback (otp-ts tool), matching the desktop lookup:
// exact name, single entry, then substring match.
const readVaultOtpSecret = (host: string): string | null => {
  const vaultPath = join(homedir(), '.otpvault', 'vault.bin')
  if (!existsSync(vaultPath)) return null
  try {
    const json = dpapiDecrypt(readFileSync(vaultPath)).toString('utf-8')
    const entries = (JSON.parse(json) as { entries?: Record<string, string> }).entries
    if (!entries) return null
    const normalizedHost = host.trim().toLowerCase()
    const names = Object.keys(entries)
    for (const name of names) {
      if (name.trim().toLowerCase() === normalizedHost) return entries[name]
    }
    if (names.length === 1) return entries[names[0]]
    for (const name of names) {
      const n = name.trim().toLowerCase()
      if (normalizedHost.includes(n) || n.includes(normalizedHost)) return entries[name]
    }
  } catch {
    // undecryptable vault — treat as absent
  }
  return null
}

const decryptCache = new Map<string, string>()

export interface GenerateOtpOptions {
  /** Overrides the Chaterm userData base directories. */
  baseDirs?: string[]
  /** Generate the code for this timestamp (tests). Defaults to now. */
  forTime?: number
  /** Disable the ~/.otpvault/vault.bin fallback (tests). Default: enabled. */
  vault?: boolean
}

/**
 * Generate the current TOTP code for a host using the desktop OTP stores.
 * Returns null when no usable secret exists (caller falls back to prompting).
 */
export const generateOtpForHost = (host: string, opts: GenerateOtpOptions = {}): string | null => {
  if (!host) return null
  const hostKey = host.trim().toLowerCase()
  const baseDirs = opts.baseDirs ?? resolveChatermBaseDirs()

  let secret = decryptCache.get(hostKey) ?? null
  if (!secret) {
    secret = readChatermOtpSecret(hostKey, baseDirs) ?? (opts.vault === false ? null : readVaultOtpSecret(host))
    if (secret) decryptCache.set(hostKey, secret)
  }
  if (!secret) return null

  try {
    return generateTOTP(secret, 6, 30, opts.forTime ?? Date.now())
  } catch {
    return null
  }
}
