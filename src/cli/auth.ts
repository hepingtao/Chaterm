// Shared auth resolution for the Chaterm CLI entry points (cfm, cfm2).
// Explicit flags/env always win; otherwise reuse the credential stored by the
// Chaterm desktop app for user@host:port when available.

import type { AuthOptions } from './connect'
import { findStoredCredential } from './assets-store'

export const authFrom = (opts: any): AuthOptions => ({
  password: opts.password ?? process.env.CFM_PASSWORD,
  identity: opts.identity,
  passphrase: opts.passphrase ?? process.env.CFM_PASSPHRASE
})

export const resolveAuth = async (opts: any, target: { credUser: string; credHost: string; port: number }): Promise<AuthOptions> => {
  const explicit = authFrom(opts)
  if (explicit.password || explicit.identity || explicit.privateKeyData) return explicit

  const stored = await findStoredCredential({ username: target.credUser, host: target.credHost, port: target.port })
  if (!stored) return explicit

  const kind = stored.authType === 'keyBased' ? 'key' : 'password'
  process.stderr.write(`using stored credentials from Chaterm desktop (${kind} auth)\n`)
  return {
    password: stored.password ?? undefined,
    privateKeyData: stored.privateKey ?? undefined,
    passphrase: stored.passphrase ?? undefined
  }
}
