#!/usr/bin/env node
// Chaterm remote-operation CLI (cfm).
// File management over SFTP plus one-shot remote command execution, reusing the
// Electron-free SFTP core in src/shared/sftp so the CLI and the desktop app
// share identical transfer logic.
//
// Build: npm run build:cli
// Run:   node dist-cli/cli/index.js --help

import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stderr } from 'node:process'
import {
  chmodRemote,
  copyOrMoveBySftp,
  deleteRemote,
  directoryDownload,
  directoryUpload,
  formatSftpList,
  readSftpDirWithFallback,
  renameRemote,
  sftpMkdirSafe,
  sftpStat,
  shellSingleQuote,
  streamTransfer
} from '../shared/sftp'
import { connectTarget, execCommand, type AuthOptions } from './connect'
import { findStoredCredential } from './assets-store'
import { generateOtpForHost, saveOtpSecret } from './otp'
import { createProgressRenderer } from './progress'
import { parseTarget, resolveRemotePath, type CliTarget } from './target'

const program = new Command()

program
  .name('cfm')
  .description('File transfer (SFTP) and remote command execution over SSH, powered by the Chaterm connection core')
  .version('0.1.0')
  .option('-p, --password <password>', 'SSH password (falls back to CFM_PASSWORD env)')
  .option('-i, --identity <path>', 'Private key file path')
  .option('--passphrase <passphrase>', 'Passphrase for the private key (falls back to CFM_PASSPHRASE env)')
  .option('-P, --port <port>', 'SSH port (default 22; JumpServer targets default 2222)')
  .option('--include-hidden', 'Include hidden (dot) files when listing', false)
  .option('-q, --quiet', 'Suppress progress output', false)

const authFrom = (opts: any): AuthOptions => ({
  password: opts.password ?? process.env.CFM_PASSWORD,
  identity: opts.identity,
  passphrase: opts.passphrase ?? process.env.CFM_PASSPHRASE
})

// Explicit flags/env always win; otherwise reuse the credential stored by the
// Chaterm desktop app for user@host:port when available.
const resolveAuth = async (opts: any, target: { credUser: string; credHost: string; port: number }): Promise<AuthOptions> => {
  const explicit = authFrom(opts)
  if (explicit.password || explicit.identity || explicit.privateKeyData) return explicit

  const stored = await findStoredCredential({ username: target.credUser, host: target.credHost, port: target.port })
  if (!stored) return explicit

  const kind = stored.authType === 'keyBased' ? 'key' : 'password'
  process.stderr.write(`using stored credentials from Chaterm desktop (${kind} auth)
`)
  return {
    password: stored.password ?? undefined,
    privateKeyData: stored.privateKey ?? undefined,
    passphrase: stored.passphrase ?? undefined
  }
}

const fail: (msg: string) => never = (msg) => {
  process.stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

const asTarget = (spec: string, opts: any): CliTarget => parseTarget(spec, opts.port ? parseInt(opts.port, 10) : undefined)

const statRemote = async (sftp: any, p: string): Promise<any | null> => {
  try {
    return await sftpStat(sftp, p)
  } catch {
    return null
  }
}

const formatListing = (items: any[]): string => {
  if (items.length === 0) return ''
  const width = Math.max(...items.map((i) => String(i.size ?? 0).length))
  return items
    .map((i) => `${i.isDir ? 'd' : i.isLink ? 'l' : '-'} ${i.mode} ${String(i.size ?? 0).padStart(width)} ${i.modTime} ${i.name}`)
    .join('\n')
}

const assertSameOrigin = (a: CliTarget, b: CliTarget) => {
  if (a.user !== b.user || a.host !== b.host || a.port !== b.port) {
    fail('Both paths must be on the same user@host:port for this command')
  }
}

program
  .command('ls')
  .description('List a remote directory. Usage: ls user@host[:/path]')
  .argument('<target>', 'user@host[:/path]')
  .action(async (spec: string) => {
    const opts = program.opts()
    const target = asTarget(spec, opts)
    const emit = createProgressRenderer(opts.quiet)
    const c = await connectTarget(target, await resolveAuth(opts, target), emit).catch((e) => fail(e.message))
    try {
      const dir = resolveRemotePath(c.home, target.path ?? '.')
      const raw = await readSftpDirWithFallback(c.sftp, dir, {
        id: target.id,
        includeHidden: Boolean(opts.includeHidden),
        deps: { resolveSshConn: () => c.conn }
      })
      const items = formatSftpList(raw, dir)
      const out = formatListing(items)
      if (out) process.stdout.write(out + '\n')
    } finally {
      c.close()
    }
  })

program
  .command('get')
  .description('Download a remote file or directory. Usage: get user@host:/remote/path [localPath]')
  .argument('<target>', 'user@host:/remote/path')
  .argument('[localPath]')
  .action(async (spec: string, localPath: string | undefined) => {
    const opts = program.opts()
    const target = asTarget(spec, opts)
    const specPath = target.path
    if (!specPath) fail('Target must include a remote path, e.g. user@host:/remote/file')
    const emit = createProgressRenderer(opts.quiet)
    const c = await connectTarget(target, await resolveAuth(opts, target), emit).catch((e) => fail(e.message))
    try {
      const remote = resolveRemotePath(c.home, specPath)
      const st = await statRemote(c.sftp, remote)
      if (!st) fail(`Remote path not found: ${remote}`)
      const dest = path.resolve(localPath ?? '.')
      const res = (st as any).isDirectory?.()
        ? await directoryDownload(c.ctx, target.id, remote, dest)
        : await streamTransfer(c.ctx, target.id, remote, dest, 'download')
      if (res.status !== 'success') fail(res.message || `Download failed: ${res.status}`)
    } finally {
      c.close()
    }
  })

program
  .command('put')
  .description('Upload a local file or directory. Usage: put <localPath> user@host:/remote/dir')
  .argument('<localPath>')
  .argument('<target>', 'user@host:/remote/dir')
  .action(async (localPath: string, spec: string) => {
    const opts = program.opts()
    const target = asTarget(spec, opts)
    const absLocal = path.resolve(localPath)
    if (!fs.existsSync(absLocal)) fail(`Local path not found: ${absLocal}`)
    const emit = createProgressRenderer(opts.quiet)
    const c = await connectTarget(target, await resolveAuth(opts, target), emit).catch((e) => fail(e.message))
    try {
      const remoteDir = resolveRemotePath(c.home, target.path ?? '.')
      const res = fs.statSync(absLocal).isDirectory()
        ? await directoryUpload(c.ctx, target.id, absLocal, remoteDir)
        : await streamTransfer(c.ctx, target.id, absLocal, remoteDir, 'upload')
      if (res.status !== 'success') fail(res.message || `Upload failed: ${res.status}`)
    } finally {
      c.close()
    }
  })

program
  .command('mkdir')
  .description('Create a remote directory (parents included). Usage: mkdir user@host:/path')
  .argument('<target>', 'user@host:/path')
  .action(async (spec: string) => {
    const opts = program.opts()
    const target = asTarget(spec, opts)
    const specPath = target.path
    if (!specPath) fail('Target must include a remote path')
    const c = await connectTarget(target, await resolveAuth(opts, target), createProgressRenderer(opts.quiet)).catch((e) => fail(e.message))
    try {
      await sftpMkdirSafe(c.sftp, resolveRemotePath(c.home, specPath))
    } catch (e: any) {
      fail(String(e?.message || e))
    } finally {
      c.close()
    }
  })

program
  .command('rm')
  .description('Delete a remote file or directory (recursive). Usage: rm user@host:/path')
  .argument('<target>', 'user@host:/path')
  .action(async (spec: string) => {
    const opts = program.opts()
    const target = asTarget(spec, opts)
    const specPath = target.path
    if (!specPath) fail('Target must include a remote path')
    const c = await connectTarget(target, await resolveAuth(opts, target), createProgressRenderer(opts.quiet)).catch((e) => fail(e.message))
    try {
      await deleteRemote(c.sftp, resolveRemotePath(c.home, specPath))
    } catch (e: any) {
      fail(typeof e === 'string' ? e : String(e?.message || e))
    } finally {
      c.close()
    }
  })

program
  .command('mv')
  .description('Rename/move on the same host. Usage: mv user@host:/src user@host:/dst')
  .argument('<src>', 'user@host:/src')
  .argument('<dst>', 'user@host:/dst')
  .action(async (srcSpec: string, dstSpec: string) => {
    const opts = program.opts()
    const src = asTarget(srcSpec, opts)
    const dst = asTarget(dstSpec, opts)
    assertSameOrigin(src, dst)
    const srcRel = src.path
    const dstRel = dst.path
    if (!srcRel || !dstRel) fail('Both targets must include remote paths')
    const c = await connectTarget(src, await resolveAuth(opts, src), createProgressRenderer(opts.quiet)).catch((e) => fail(e.message))
    try {
      const res = await renameRemote(c.sftp, resolveRemotePath(c.home, srcRel), resolveRemotePath(c.home, dstRel))
      if (res.status !== 'success') fail(res.message || 'Move failed')
    } finally {
      c.close()
    }
  })

program
  .command('cp')
  .description('Copy on the same host (server-side streaming). Usage: cp user@host:/src user@host:/dst')
  .argument('<src>', 'user@host:/src')
  .argument('<dst>', 'user@host:/dst')
  .action(async (srcSpec: string, dstSpec: string) => {
    const opts = program.opts()
    const src = asTarget(srcSpec, opts)
    const dst = asTarget(dstSpec, opts)
    assertSameOrigin(src, dst)
    const srcRel = src.path
    const dstRel = dst.path
    if (!srcRel || !dstRel) fail('Both targets must include remote paths')
    const emit = createProgressRenderer(opts.quiet)
    const c = await connectTarget(src, await resolveAuth(opts, src), emit).catch((e) => fail(e.message))
    try {
      const res = await copyOrMoveBySftp(c.ctx, {
        id: src.id,
        srcPath: resolveRemotePath(c.home, srcRel),
        targetPath: resolveRemotePath(c.home, dstRel),
        action: 'copy'
      })
      if (res.status !== 'success') fail(res.message || 'Copy failed')
    } finally {
      c.close()
    }
  })

program
  .command('chmod')
  .description('Change remote file mode. Usage: chmod <mode> user@host:/path [-r]')
  .argument('<mode>', 'Octal mode, e.g. 644 or 755')
  .argument('<target>', 'user@host:/path')
  .option('-r, --recursive', 'Apply recursively', false)
  .action(async (mode: string, spec: string, cmdOpts: { recursive: boolean }) => {
    const opts = program.opts()
    if (!/^[0-7]{3,4}$/.test(mode)) fail(`Invalid mode: ${mode}`)
    const target = asTarget(spec, opts)
    const specPath = target.path
    if (!specPath) fail('Target must include a remote path')
    const c = await connectTarget(target, await resolveAuth(opts, target), createProgressRenderer(opts.quiet)).catch((e) => fail(e.message))
    try {
      const res = await chmodRemote(c.sftp, resolveRemotePath(c.home, specPath), mode, Boolean(cmdOpts.recursive))
      if (res.status !== 'success') fail(res.message || 'Chmod failed')
    } finally {
      c.close()
    }
  })

program
  .command('exec')
  .description('Run a command on a remote host, like ssh user@host cmd. Usage: exec user@host[:/cwd] [--] <command...>')
  // ssh(1)-style parsing: arguments after the target belong to the remote
  // command (e.g. `exec host ls -ltr`), so unknown options are allowed through.
  // Help keeps only the long `--help` form so a remote `df -h` is not eaten;
  // auth/quiet flags are redeclared here so they can be used like on ssh
  // (`exec -i key host cmd`), while program-level flags keep working too.
  .helpOption('--help', 'display help for command')
  .allowUnknownOption()
  .option('-p, --password <password>', 'SSH password (falls back to CFM_PASSWORD env)')
  .option('-i, --identity <path>', 'Private key file path')
  .option('--passphrase <passphrase>', 'Passphrase for the private key (falls back to CFM_PASSPHRASE env)')
  .option('-q, --quiet', 'Suppress progress output', false)
  .argument('<target>', 'user@host[:/working-directory]')
  .argument('[command...]', 'Remote command; a leading -- can be used as an explicit separator')
  .action(async (spec: string, command: string[], cmdOpts: AuthOptions & { quiet?: boolean }) => {
    const opts = { ...program.opts(), ...cmdOpts }
    const cmdline = command.join(' ').trim()
    if (!cmdline) fail('No command given, e.g. cfm exec user@host df -h')
    const target = asTarget(spec, opts)
    const c = await connectTarget(target, await resolveAuth(opts, target), createProgressRenderer(Boolean(opts.quiet))).catch((e) => fail(e.message))
    try {
      let remote = cmdline
      if (target.path) {
        const cwd = resolveRemotePath(c.home, target.path)
        remote = `cd ${shellSingleQuote(cwd)} && (${cmdline})`
      }
      const { code, signal } = await execCommand(c.conn, remote)
      // Mirror ssh(1): exit with the remote status; 128 when it died by signal.
      process.exitCode = signal ? 128 : (code ?? 1)
    } finally {
      c.close()
    }
  })

// Hidden-input prompt for secrets: typed characters are swallowed by a
// discarded output stream, so they never reach the terminal or shell history.
const promptHidden = async (text: string): Promise<string> => {
  const mute = new Writable({
    write(_chunk, _enc, cb) {
      cb()
    }
  })
  stderr.write(text)
  const rl = readline.createInterface({ input: stdin, output: mute, terminal: stdin.isTTY === true })
  try {
    return (await rl.question('')).trim()
  } finally {
    rl.close()
    stderr.write('\n')
  }
}

program
  .command('otp')
  .description('Print the current TOTP code for a host, or store its secret with --set. Usage: otp <host> [--set]')
  .argument('<host>', 'Host key in otp-secrets.json, e.g. jump.itouchtv.cn')
  .option('--set', 'Store or replace the OTP secret via a hidden prompt; it is written only as lk1-encrypted ciphertext', false)
  .action(async (host: string, cmdOpts: { set: boolean }) => {
    const hostKey = host.trim()
    if (!cmdOpts.set) {
      const code = generateOtpForHost(hostKey)
      if (!code) fail(`No usable OTP secret for ${host} (checked ~/.config/chaterm*/otp-secrets.json and ~/.otpvault/vault.bin)`)
      process.stdout.write(code + '\n')
      return
    }
    const secret = await promptHidden('OTP base32 secret (input hidden): ')
    if (!secret) fail('No secret entered')
    let stored: { dir: string; code: string | null }
    try {
      stored = saveOtpSecret(hostKey, secret)
    } catch (e: any) {
      fail(`Invalid OTP secret: ${e?.message || e}`)
    }
    stderr.write(`OTP secret stored for ${hostKey} in ${path.join(stored.dir, 'otp-secrets.json')} (lk1-encrypted)\n`)
    if (stored.code) stderr.write(`Current code: ${stored.code}\n`)
  })

program.parseAsync(process.argv).catch((e) => fail(e?.message || String(e)))
