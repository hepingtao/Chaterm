//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import crypto from 'crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode a Base32-encoded string to a Buffer.
 * Tolerates spaces, lowercase, and missing padding.
 */
export function base32Decode(secret: string): Buffer {
  const clean = secret.replace(/=+$/, '').toUpperCase().replace(/\s/g, '')
  let bits = ''
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char)
    if (idx === -1) {
      throw new Error(`Invalid base32 character: ${char}`)
    }
    bits += idx.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

/**
 * Generate a TOTP code (RFC 6238).
 *
 * Uses unchecked mode: some services (e.g. JumpServer) provide a secret with
 * only 80 bits, below the RFC 6238 recommended 128 bits, but the standard does
 * not enforce that limit.
 *
 * @param secret  Base32-encoded shared secret
 * @param digits  Number of digits in the output code (default 6)
 * @param step    Time step in seconds (default 30)
 * @param forTime Timestamp to generate the code for (default: now)
 */
export function generateTOTP(secret: string, digits = 6, step = 30, forTime: number = Date.now()): string {
  const key = base32Decode(secret)
  const counter = Math.floor(forTime / 1000 / step)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))

  const hmac = crypto.createHmac('sha1', key).update(counterBuffer).digest()

  // Dynamic truncation (RFC 4226)
  const offset = hmac[hmac.length - 1] & 0x0f
  const binary = ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff)

  const otp = binary % Math.pow(10, digits)
  return otp.toString().padStart(digits, '0')
}

/**
 * Seconds remaining in the current TOTP window.
 */
export function totpSecondsRemaining(step = 30): number {
  return step - (Math.floor(Date.now() / 1000) % step)
}
