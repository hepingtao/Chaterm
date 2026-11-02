// scp-style target parsing for the Chaterm remote-operation CLI:
//   user@host[:port via --port]:/path                       (direct SSH)
//   user@system@targetIp@bastion:/path                      (JumpServer bastion,
//   user@targetIp@bastion:/path                              compound username,
//                                                            default port 2222)
// With a default bastion configured (cfm config.json or CFM_BASTION/CFM_USER),
// three bastion-less shorthand forms resolve to the compound username:
//   assetIp                 — login user from defaultUser, system name derived
//   system@assetIp          — system segment must equal the derived name,
//                             login user from defaultUser
//   user@system@assetIp     — only the bastion comes from the default
// Disambiguation: a real bastion form always ends with the bastion host, so a
// target whose last segment is an IPv4 is a shorthand; `X@IP` stays a direct
// target unless X equals the derived system name.

export interface TargetDefaults {
  /** Default JumpServer bastion host for bastion-less shorthand targets. */
  bastion?: string
  /** Default login user for shorthand targets that omit it. */
  user?: string
}

export interface CliTarget {
  /** Effective SSH username (compound `user@system@ip` behind a bastion). */
  user: string
  /** Host to connect to (the bastion when present). */
  host: string
  port: number
  path?: string
  id: string
  /** Present when the target routes through a JumpServer bastion. */
  bastion?: {
    loginuser: string
    systemName: string
    targetIp: string
    host: string
  }
  /** Identity used for credential lookup (bastion login, or the direct user). */
  credUser: string
  /** Host used for credential lookup. */
  credHost: string
}

// Mirrors the desktop's deriveSystemNameFromHost: take the second-level domain
// of the bastion host (jump.itouchtv.cn -> itouchtv). IP bastions have no
// derivable system name.
export const deriveSystemName = (host: string): string | null => {
  if (!host) return null
  const parts = String(host).split('.')
  const isIP = parts.length === 4 && parts.every((p) => /^\d+$/.test(p))
  if (isIP) return null
  if (parts.length < 2) return null
  const name = parts[parts.length - 2]
  return name || null
}

const isIPv4 = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s)

export const parseTarget = (spec: string, port?: number, sessionId = '1', defaults?: TargetDefaults): CliTarget => {
  const s = String(spec || '').trim()
  if (!s) throw new Error('Empty target')

  let rest = s
  let targetPath: string | undefined

  const pathIdx = s.indexOf(':')
  if (pathIdx >= 0) {
    rest = s.slice(0, pathIdx)
    targetPath = s.slice(pathIdx + 1)
    if (targetPath === '') targetPath = undefined
  }

  const atIdx = rest.indexOf('@')
  const makeId = (user: string, host: string, p: number) => `${user}@${host}:${p}:cli:files-${sessionId}`

  // Build a JumpServer shorthand target against the configured default bastion.
  const buildShorthand = (loginuser: string, systemName: string, assetHost: string): CliTarget => {
    const bastionHost = defaults!.bastion!
    const effectivePort = Number(port) || 2222
    const compoundUser = `${loginuser}@${systemName}@${assetHost}`
    return {
      user: compoundUser,
      host: bastionHost,
      port: effectivePort,
      path: targetPath,
      id: makeId(compoundUser, bastionHost, effectivePort),
      bastion: { loginuser, systemName, targetIp: assetHost, host: bastionHost },
      credUser: loginuser,
      credHost: bastionHost
    }
  }

  const shorthandNeedsUser = (): Error =>
    new Error(
      `Login user required for shorthand target '${spec}': set defaultUser in ${'~/.config/cfm/config.json'} (or CFM_USER), or use the user@system@ip@bastion form`
    )

  // Bare asset host with no `@` at all: only meaningful as a JumpServer
  // shorthand; without a default bastion it stays invalid as before.
  if (atIdx < 0) {
    if (defaults?.bastion) {
      const systemName = deriveSystemName(defaults.bastion)
      if (!systemName) throw new Error(`Cannot derive the JumpServer system name from default bastion '${defaults.bastion}'`)
      if (!defaults.user) throw shorthandNeedsUser()
      return buildShorthand(defaults.user, systemName, rest)
    }
    throw new Error(`Invalid target '${spec}': expected user@host[/path] form`)
  }

  if (atIdx < 1) throw new Error(`Invalid target '${spec}': expected user@host[/path] form`)

  const loginuser = rest.slice(0, atIdx)
  const hostPart = rest.slice(atIdx + 1)
  if (!loginuser || !hostPart) throw new Error(`Invalid target '${spec}': expected user@host[/path] form`)

  // `system@assetIp`: the system segment sits in the loginuser slot and the
  // host part is the bare asset IP. Only when it equals the system name
  // derived from the default bastion; any other user@host stays direct.
  if (!hostPart.includes('@') && defaults?.bastion && loginuser === deriveSystemName(defaults.bastion)) {
    if (!defaults.user) throw shorthandNeedsUser()
    return buildShorthand(defaults.user, loginuser, hostPart)
  }

  if (hostPart.includes('@')) {
    // JumpServer compound target.
    const segs = hostPart.split('@')
    if (segs.length > 3) throw new Error(`Invalid target '${spec}': expected user@system@ip@bastion or user@ip@bastion`)

    const last = segs[segs.length - 1]
    // `user@system@assetIp`: two segments ending in an IPv4. The working short
    // bastion form ends with the bastion host, so this shape was always an
    // error before and is free for the bastion-less shorthand.
    if (segs.length === 2 && isIPv4(last)) {
      if (!defaults?.bastion) {
        throw new Error(`Cannot derive the JumpServer system name from bastion '${last}'; use the user@system@ip@bastion form`)
      }
      return buildShorthand(loginuser, segs[0], segs[1])
    }

    let systemName: string
    let targetIp: string
    let bastionHost: string
    if (segs.length === 3) {
      systemName = segs[0]
      targetIp = segs[1]
      bastionHost = segs[2]
    } else {
      targetIp = segs[0]
      bastionHost = segs[1]
      systemName = deriveSystemName(bastionHost) || ''
      if (!systemName) {
        throw new Error(`Cannot derive the JumpServer system name from bastion '${bastionHost}'; use the user@system@ip@bastion form`)
      }
    }
    if (!systemName || !targetIp || !bastionHost) {
      throw new Error(`Invalid target '${spec}': empty part in user@system@ip@bastion`)
    }

    const effectivePort = Number(port) || 2222
    const compoundUser = `${loginuser}@${systemName}@${targetIp}`
    return {
      user: compoundUser,
      host: bastionHost,
      port: effectivePort,
      path: targetPath,
      id: makeId(compoundUser, bastionHost, effectivePort),
      bastion: { loginuser, systemName, targetIp, host: bastionHost },
      credUser: loginuser,
      credHost: bastionHost
    }
  }

  const effectivePort = Number(port) || 22
  return {
    user: loginuser,
    host: hostPart,
    port: effectivePort,
    path: targetPath,
    id: makeId(loginuser, hostPart, effectivePort),
    credUser: loginuser,
    credHost: hostPart
  }
}

// Expand a remote path against the resolved HOME when it is relative.
export const resolveRemotePath = (home: string, p: string): string => {
  const raw = String(p || '').trim()
  if (!raw || raw === '~') return home || '/'
  if (raw.startsWith('~/')) return (home || '').replace(/\/$/, '') + raw.slice(1)
  if (raw.startsWith('/')) return raw
  return (home || '').replace(/\/$/, '') + '/' + raw
}
