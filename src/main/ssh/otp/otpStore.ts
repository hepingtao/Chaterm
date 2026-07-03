//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getUserDataPath } from '../../config/edition'
import { getCredentialStore } from '../../services/database/credential-store'
import { generateTOTP, base32Decode } from './totp'
import { generateOtpFromVault } from './otpTsVault'

const logger = createLogger('otp-store')

const OTP_SECRETS_FILE = 'otp-secrets.json'

/**
 * In-memory representation of the OTP secrets store.
 * Keys are host identifiers (host or host:port), values are encrypted secrets.
 */
interface OtpSecretsMap {
  [host: string]: string // encrypted secret
}

function getOtpSecretsPath(): string {
  return join(getUserDataPath(), OTP_SECRETS_FILE)
}

let cachedSecrets: OtpSecretsMap | null = null

function loadSecrets(): OtpSecretsMap {
  if (cachedSecrets) return cachedSecrets

  const filePath = getOtpSecretsPath()
  if (!existsSync(filePath)) {
    cachedSecrets = {}
    return cachedSecrets
  }

  try {
    const raw = readFileSync(filePath, 'utf-8')
    cachedSecrets = JSON.parse(raw) as OtpSecretsMap
  } catch (error) {
    logger.error('Failed to load OTP secrets, starting fresh', { error: error })
    cachedSecrets = {}
  }
  return cachedSecrets
}

function saveSecrets(secrets: OtpSecretsMap): void {
  const filePath = getOtpSecretsPath()
  const dir = join(getUserDataPath())
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(filePath, JSON.stringify(secrets, null, 2), { mode: 0o600 })
}

/**
 * Normalise a host identifier.
 * Strips whitespace and lowercases for consistent lookups.
 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase()
}

/**
 * Build a lookup key from host and optional port.
 */
export function buildHostKey(host: string, port?: number): string {
  const h = normalizeHost(host)
  return port ? `${h}:${port}` : h
}

/**
 * Add or update an OTP secret for a host.
 * The secret is encrypted before storage.
 */
export async function addOtpSecret(host: string, secret: string): Promise<void> {
  const trimmedSecret = secret.replace(/\s/g, '')
  if (trimmedSecret.length < 16) {
    throw new Error('OTP secret is too short (minimum 16 base32 characters)')
  }

  // Validate by attempting to decode
  try {
    base32Decode(trimmedSecret)
  } catch (error) {
    throw new Error(`Invalid OTP secret: ${(error as Error).message}`)
  }

  const store = getCredentialStore()
  const encrypted = await store.encryptSecret(trimmedSecret)

  const secrets = loadSecrets()
  secrets[normalizeHost(host)] = encrypted
  saveSecrets(secrets)

  logger.info('OTP secret saved', { host: normalizeHost(host) })
}

/**
 * Remove the OTP secret for a host.
 * Returns true if a secret was removed.
 */
export function removeOtpSecret(host: string): boolean {
  const key = normalizeHost(host)
  const secrets = loadSecrets()
  if (key in secrets) {
    delete secrets[key]
    saveSecrets(secrets)
    logger.info('OTP secret removed', { host: key })
    return true
  }
  return false
}

/**
 * Check whether an OTP secret exists for a host.
 */
export function hasOtpSecret(host: string): boolean {
  const secrets = loadSecrets()
  return normalizeHost(host) in secrets
}

/**
 * List all hosts that have OTP secrets configured.
 */
export function listOtpHosts(): string[] {
  const secrets = loadSecrets()
  return Object.keys(secrets).sort()
}

/**
 * Generate the current TOTP code for a host.
 *
 * Lookup order:
 * 1. chaterm's own OTP secret store (otp-secrets.json, encrypted via CredentialStore)
 * 2. otp-ts vault.bin (~/.otpvault/vault.bin, DPAPI-encrypted) as fallback
 *
 * Returns null if no secret is found in either store.
 */
export async function generateOtpForHost(host: string): Promise<string | null> {
  const key = normalizeHost(host)
  const secrets = loadSecrets()
  const encrypted = secrets[key]

  // 1. Try chaterm's own store first
  if (encrypted) {
    try {
      const store = getCredentialStore()
      const secret = await store.decryptSecret(encrypted)
      return generateTOTP(secret)
    } catch (error) {
      logger.error('Failed to generate OTP from chaterm store', { host: key, error: error })
    }
  }

  // 2. Fall back to otp-ts vault.bin
  const vaultCode = generateOtpFromVault(host)
  if (vaultCode) {
    logger.info('Generated OTP from otp-ts vault.bin', { host: key })
    return vaultCode
  }

  return null
}

/**
 * Clear the in-memory cache (useful for tests).
 */
export function clearOtpCache(): void {
  cachedSecrets = null
}
