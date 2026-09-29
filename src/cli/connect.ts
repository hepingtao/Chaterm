// SSH/SFTP connection setup for the Chaterm file-management CLI.
// Wraps ssh2 directly and exposes the same SftpOpsDeps contract the shared
// core expects, so CLI and desktop run identical transfer logic.

import { Client } from 'ssh2'
import fs from 'node:fs'
import os from 'node:os'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import type { SftpOpsDeps } from '../shared/sftp'
import type { CliTarget } from './target'
import { generateOtpForHost } from './otp'

export interface AuthOptions {
  password?: string
  identity?: string
  passphrase?: string
  /** Raw PEM private key (e.g. reused from a stored Chaterm asset). */
  privateKeyData?: string
}

export interface CliConnection {
  conn: Client
  sftp: any
  home: string
  ctx: SftpOpsDeps
  close: () => void
}

export interface ExecResult {
  code: number | null
  signal: string | null
}

export interface ExecWriters {
  out: NodeJS.WritableStream
  err: NodeJS.WritableStream
}

// Run a command over the ssh2 exec channel, streaming output like ssh(1).
// Resolves with the remote exit status; the caller maps it to process.exitCode.
export const execCommand = (
  conn: Client,
  command: string,
  writers: ExecWriters = { out: process.stdout, err: process.stderr }
): Promise<ExecResult> =>
  new Promise((resolve, reject) => {
    conn.exec(command, (err, stream: any) => {
      if (err || !stream) return reject(err || new Error('Failed to open exec channel'))
      stream.on('data', (chunk: Buffer) => writers.out.write(chunk))
      stream.stderr?.on('data', (chunk: Buffer) => writers.err.write(chunk))
      stream.on('close', (code: number | null, signal: string | null) => resolve({ code, signal }))
    })
  })

const readIdentity = (identityPath?: string): { privateKey?: string; passphrase?: string } => {
  if (!identityPath) return {}
  const resolved = identityPath.replace(/^~(?=$|\/|\\)/, os.homedir())
  if (!fs.existsSync(resolved)) throw new Error(`Identity file not found: ${resolved}`)
  return { privateKey: fs.readFileSync(resolved, 'utf8') }
}

export const connectTarget = async (target: CliTarget, auth: AuthOptions, emit: (p: Record<string, any>) => void): Promise<CliConnection> => {
  const conn = new Client()
  const connectConfig: any = {
    host: target.host,
    port: target.port,
    username: target.user,
    // JumpServer bastions are slow to handshake and typically require
    // keyboard-interactive (OTP / verification) even for key auth.
    readyTimeout: 120000,
    keepaliveInterval: 30000,
    keepaliveCountMax: 3,
    tryKeyboard: true
  }

  if (auth.identity) {
    const { privateKey } = readIdentity(auth.identity)
    connectConfig.privateKey = privateKey
    if (auth.passphrase) connectConfig.passphrase = auth.passphrase
  } else if (auth.privateKeyData) {
    connectConfig.privateKey = auth.privateKeyData
    if (auth.passphrase) connectConfig.passphrase = auth.passphrase
  } else if (auth.password) {
    connectConfig.password = auth.password
    connectConfig.tryKeyboard = true
  } else {
    throw new Error(
      'No authentication: use --password (or CFM_PASSWORD env), --identity <keyfile>, or add the asset in Chaterm desktop so cfm can reuse the stored credential'
    )
  }

  const connected = new Promise<void>((resolve, reject) => {
    let settled = false
    const safe = (fn: () => void) => {
      if (settled) return
      try {
        fn()
      } catch {}
    }

    conn.on('ready', () =>
      safe(() => {
        settled = true
        resolve()
      })
    )
    conn.on('error', (err: Error) =>
      safe(() => {
        settled = true
        reject(err)
      })
    )
    // OTP auto-fill (same as the desktop): try the saved TOTP secret once per
    // connection before any other interactive strategy.
    let otpTried = false
    conn.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => {
      void (async () => {
        try {
          if (!otpTried) {
            otpTried = true
            const otpCode = generateOtpForHost(target.host)
            if (otpCode) {
              output.write('auto-filling OTP from Chaterm secret store\n')
              finish([otpCode])
              return
            }
          }
          if (auth.password) {
            finish(prompts.map(() => auth.password!))
            return
          }
          if (!input.isTTY) {
            safe(() => {
              settled = true
              reject(
                new Error(
                  'The server asks for interactive verification (e.g. JumpServer MFA). Run cfm in a real terminal to answer the prompt, or provide --password'
                )
              )
            })
            return
          }
          // Interactive terminal: prompt for each question (hidden input).
          const rl = readline.createInterface({ input, output })
          try {
            const answers: string[] = []
            for (const prompt of prompts) {
              const text = prompt?.prompt || 'Verification: '
              answers.push(await rl.question(text))
            }
            finish(answers)
          } finally {
            rl.close()
          }
        } catch (e: any) {
          safe(() => {
            settled = true
            reject(new Error(`Interactive auth failed: ${e?.message || e}`))
          })
        }
      })()
    })
  })

  conn.connect(connectConfig)
  await connected

  const sftp = await new Promise<any>((resolve, reject) => {
    conn.sftp((err, s) => (err || !s ? reject(err || new Error('SFTP unavailable')) : resolve(s)))
  })

  const home = await new Promise<string>((resolve) => {
    sftp.realpath('.', (err: Error | null, abs?: string) => resolve(!err && abs ? abs : '/'))
  })

  const ctx: SftpOpsDeps = {
    getSftp: () => sftp,
    getHostLabel: () => `${target.user} via ${target.host}:${target.port}`,
    emit,
    tempDir: os.tmpdir()
  }

  return {
    conn,
    sftp,
    home,
    ctx,
    close: () => {
      try {
        sftp.end()
      } catch {}
      try {
        conn.end()
      } catch {}
    }
  }
}
