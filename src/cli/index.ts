#!/usr/bin/env node
// Chaterm file-management CLI.
// Reuses the Electron-free SFTP core in src/shared/sftp so the CLI and the
// desktop app share identical transfer logic.
//
// Build: npm run build:cli
// Run:   node dist-cli/cli/index.js --help

import { Command } from 'commander'
import fs from 'node:fs'
import path from 'node:path'
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
  streamTransfer
} from '../shared/sftp'
import { connectTarget, type AuthOptions } from './connect'
import { findStoredCredential } from './assets-store'
import { createProgressRenderer } from './progress'
import { parseTarget, resolveRemotePath, type CliTarget } from './target'

const program = new Command()

program
  .name('chaterm-files')
  .description('File transfer over SFTP, powered by the Chaterm file-management core')
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

program.parseAsync(process.argv).catch((e) => fail(e?.message || String(e)))
