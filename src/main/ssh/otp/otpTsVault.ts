//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { execFileSync } from 'child_process'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { generateTOTP } from './totp'

const logger = createLogger('otp-ts-vault')

const VAULT_DIR = '.otpvault'
const RUST_VAULT_FILE = 'vault.bin'

interface OtpTsVault {
  entries: Record<string, string>
}

let cachedVault: OtpTsVault | null = null

function getVaultBinPath(): string {
  return join(homedir(), VAULT_DIR, RUST_VAULT_FILE)
}

/**
 * Decrypt vault.bin using Windows DPAPI via PowerShell.
 *
 * vault.bin is created by the otp-ts CLI and contains DPAPI-encrypted JSON:
 *   { "entries": { "<serviceName>": "<base32Secret>", ... } }
 *
 * Since the project doesn't include koffi/FFI, we shell out to PowerShell which
 * can call .NET's System.Security.Cryptography.ProtectedData directly.
 * Uses -EncodedCommand to avoid quoting issues with PowerShell special chars.
 */
function dpapiDecrypt(data: Buffer): string {
  const b64 = data.toString('base64')
  const psScript =
    'Add-Type -AssemblyName System.Security;' +
    "$bytes = [Convert]::FromBase64String('" +
    b64 +
    "');" +
    '$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
    '[Console]::OpenStandardOutput().Write($decrypted, 0, $decrypted.Length);'

  // EncodedCommand expects Base64 of UTF-16LE encoded script text
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64')

  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'buffer',
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  }).toString('utf-8')
}

/**
 * Load and decrypt the otp-ts vault.bin.
 * Results are cached for the process lifetime.
 * Returns null if vault.bin doesn't exist or can't be decrypted.
 */
function loadVault(): OtpTsVault | null {
  if (cachedVault) return cachedVault

  const vaultPath = getVaultBinPath()
  if (!existsSync(vaultPath)) {
    return null
  }

  try {
    const encrypted = readFileSync(vaultPath)
    const json = dpapiDecrypt(encrypted)
    const vault = JSON.parse(json) as OtpTsVault
    if (!vault.entries || typeof vault.entries !== 'object') {
      logger.warn('vault.bin has unexpected structure')
      return null
    }
    cachedVault = vault
    logger.info('Loaded otp-ts vault.bin', { entryCount: Object.keys(vault.entries).length })
    return vault
  } catch (error) {
    logger.error('Failed to load otp-ts vault.bin', { error: error })
    return null
  }
}

/**
 * Find the best matching secret from vault.bin for a given host.
 *
 * Matching strategy (in order):
 * 1. Exact match: service name equals host (case-insensitive)
 * 2. Single entry: if vault has only one entry, use it
 * 3. Substring match: host contains service name or vice versa
 */
function findSecretForHost(host: string): string | null {
  const vault = loadVault()
  if (!vault || !vault.entries) return null

  const entries = vault.entries
  const normalizedHost = host.trim().toLowerCase()
  const serviceNames = Object.keys(entries)

  // 1. Exact match
  for (const name of serviceNames) {
    if (name.trim().toLowerCase() === normalizedHost) {
      return entries[name]
    }
  }

  // 2. Single entry fallback (most common: one OTP secret for jumpserver)
  if (serviceNames.length === 1) {
    return entries[serviceNames[0]]
  }

  // 3. Substring match
  for (const name of serviceNames) {
    const normalizedName = name.trim().toLowerCase()
    if (normalizedHost.includes(normalizedName) || normalizedName.includes(normalizedHost)) {
      return entries[name]
    }
  }

  return null
}

/**
 * Generate a TOTP code for a host using the otp-ts vault.bin.
 * Returns null if vault.bin doesn't exist or no matching secret is found.
 */
export function generateOtpFromVault(host: string): string | null {
  const secret = findSecretForHost(host)
  if (!secret) return null

  try {
    return generateTOTP(secret)
  } catch (error) {
    logger.error('Failed to generate TOTP from vault.bin secret', { host, error: error })
    return null
  }
}

/**
 * Check whether vault.bin exists and has any entries.
 */
export function hasVaultEntries(): boolean {
  const vault = loadVault()
  return !!vault && Object.keys(vault.entries).length > 0
}

/**
 * Clear the in-memory cache (useful for tests or after vault.bin changes).
 */
export function clearVaultCache(): void {
  cachedVault = null
}
