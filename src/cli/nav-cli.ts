#!/usr/bin/env node
// cfm2: experimental JumpServer-aligned remote exec.
//
// Connects to the bastion with the plain login user and drives the interactive
// asset menu (Opt>) to reach the target, like the Chaterm desktop terminal.
// This resolves assets within the user's authorized list, so bastions with
// duplicated asset IPs still connect — which the compound-username direct path
// (cfm exec) rejects server-side. File-transfer commands are not covered: the
// desktop's SFTP uses the same compound-username path as cfm.
//
// Superseded plan: once verified against real bastions, cfm2's navigation
// replaces cfm exec's direct path.

import { Command } from 'commander'
import readline from 'node:readline/promises'
import { Writable } from 'node:stream'
import { stdin, stderr } from 'node:process'
import { connectTarget, type AuthOptions } from './connect'
import { loadCfmConfig } from './config'
import { resolveAuth } from './auth'
import { findStoredCredential } from './assets-store'
import { navExec } from './nav'
import { createProgressRenderer } from './progress'
import { parseTarget, type CliTarget } from './target'

const program = new Command()

program
  .name('cfm2')
  .description('Remote exec via JumpServer interactive navigation (desktop-aligned; works with duplicated asset IPs)')
  .version('0.1.0')
  .option('-p, --password <password>', 'Bastion SSH password (falls back to CFM_PASSWORD env)')
  .option('-i, --identity <path>', 'Private key file path')
  .option('--passphrase <passphrase>', 'Passphrase for the private key (falls back to CFM_PASSPHRASE env)')
  .option('-P, --port <port>', 'Bastion SSH port (default 2222 for JumpServer targets)')
  .option('-q, --quiet', 'Suppress progress output', false)
  .showHelpAfterError('(run `cfm2 exec --help` for usage)')

const fail: (msg: string) => never = (msg) => {
  stderr.write(`error: ${msg}\n`)
  process.exit(1)
}

const cfmConfig = loadCfmConfig()

const asTarget = (spec: string, opts: any): CliTarget =>
  parseTarget(
    spec,
    opts.port ? parseInt(opts.port, 10) : undefined,
    '1',
    cfmConfig.defaultBastion || cfmConfig.defaultUser ? { bastion: cfmConfig.defaultBastion, user: cfmConfig.defaultUser } : undefined
  )

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
  .command('exec')
  .description('Run a command on a JumpServer asset. Usage: exec user@system@assetIp@bastion[:/cwd] [--] <command...>')
  .helpOption('--help', 'display help for command')
  .allowUnknownOption()
  .option('-p, --password <password>', 'Bastion SSH password (falls back to CFM_PASSWORD env)')
  .option('-i, --identity <path>', 'Private key file path')
  .option('--passphrase <passphrase>', 'Passphrase for the private key (falls back to CFM_PASSPHRASE env)')
  .option('-P, --port <port>', 'Bastion SSH port (default 2222 for JumpServer targets)')
  .option('-q, --quiet', 'Suppress progress output', false)
  .option('-v, --verbose', 'Show the JumpServer menu navigation (banner, tables, account selection)', false)
  .option('--account <id|username>', 'Auto-select the asset account instead of prompting; unmatched values fall back to the prompt')
  .addHelpText(
    'after',
    `
Connects with the plain login user and navigates the interactive asset menu,
so duplicated asset IPs resolve like they do in the Chaterm desktop. All
arguments after the target belong to the remote command.

Target formats (full list: cfm --help):
  user@system@assetIp@bastion[:/cwd]   JumpServer bastion
  user@assetIp@bastion[:/cwd]          short bastion form
  assetIp[:/cwd]                       shorthand via the default bastion
  system@assetIp[:/cwd]                  (~/.config/cfm/config.json or
  user@system@assetIp[:/cwd]             CFM_BASTION / CFM_USER env)`
  )
  .argument('<target>', 'JumpServer target, e.g. user@system@assetIp@bastion[:/cwd]')
  .argument('[command...]', 'Remote command; a leading -- can be used as an explicit separator')
  .action(async (spec: string, command: string[], cmdOpts: AuthOptions & { quiet?: boolean; verbose?: boolean; port?: string; account?: string }) => {
    const opts = { ...program.opts(), ...cmdOpts }
    const cmdline = command.join(' ').trim()
    if (!cmdline) fail('No command given, e.g. cfm2 exec 10.0.0.5 df -h')
    const target = asTarget(spec, opts)
    if (!target.bastion) fail('cfm2 only supports JumpServer bastion targets; use cfm exec for direct hosts')

    const { bastion } = target
    const auth = await resolveAuth(opts, target).catch((e) => fail(e.message))
    // Plain login user for the interactive menu (not the compound username).
    const navTarget: CliTarget = { ...target, user: bastion.loginuser }
    const c = await connectTarget(navTarget, auth, createProgressRenderer(Boolean(opts.quiet)), { skipSftp: true }).catch((e) => fail(e.message))

    try {
      // Best-effort credential for the target asset account when JumpServer
      // asks for it; without one cfm2 prompts (hidden input).
      const stored = await findStoredCredential({ username: bastion.systemName, host: bastion.targetIp, port: 22 }).catch(() => null)
      if (stored) stderr.write('using stored target credential from Chaterm desktop\n')

      const rc = await navExec(c.conn, {
        targetIp: bastion.targetIp,
        command: cmdline,
        targetPath: target.path,
        targetCredential: stored?.password ?? undefined,
        preferredAccountUser: bastion.systemName,
        preferredAccount: opts.account,
        verbose: Boolean(opts.verbose),
        out: process.stdout,
        err: stderr,
        promptHidden
      })
      process.exitCode = rc
    } finally {
      c.close()
    }
  })

program.parseAsync(process.argv).catch((e) => fail(e?.message || String(e)))
