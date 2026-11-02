// cfm CLI configuration: optional defaults for JumpServer bastion shorthand
// targets. Loaded from (1) env CFM_BASTION / CFM_USER, then (2)
// <configBase>/cfm/config.json:
//   { "defaultBastion": "jump.example.cn", "defaultUser": "alice" }
// No secrets belong in this file; it only names the bastion and login user.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CfmConfig {
  /** Default JumpServer bastion host for bastion-less shorthand targets. */
  defaultBastion?: string
  /** Default login user for shorthand targets that omit it. */
  defaultUser?: string
}

export const resolveCfmConfigPath = (baseDir?: string): string => {
  const base = baseDir ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  return join(base, 'cfm', 'config.json')
}

export const loadCfmConfig = (opts: { baseDir?: string } = {}): CfmConfig => {
  const cfg: CfmConfig = {}

  const filePath = resolveCfmConfigPath(opts.baseDir)
  if (existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as CfmConfig
      if (typeof raw.defaultBastion === 'string' && raw.defaultBastion.trim()) cfg.defaultBastion = raw.defaultBastion.trim()
      if (typeof raw.defaultUser === 'string' && raw.defaultUser.trim()) cfg.defaultUser = raw.defaultUser.trim()
    } catch {
      // Malformed config file — fall through to env/none rather than failing
      // every command over a typo.
    }
  }

  if (process.env.CFM_BASTION?.trim()) cfg.defaultBastion = process.env.CFM_BASTION.trim()
  if (process.env.CFM_USER?.trim()) cfg.defaultUser = process.env.CFM_USER.trim()
  return cfg
}
