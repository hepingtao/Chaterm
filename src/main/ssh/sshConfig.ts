import { getUserConfigFromRenderer } from '../index'
const logger = createLogger('ssh.config')

export interface SshKeepaliveConfig {
  keepaliveInterval: number
  keepaliveCountMax: number
}

const DEFAULT_KEEPALIVE_INTERVAL = 10 // seconds
const DEFAULT_IDLE_TIMEOUT = 0 // 0 = no timeout

/**
 * Read SSH keepalive and idle timeout settings from user config.
 * Falls back to defaults if config is unavailable.
 */
export async function getSshKeepaliveConfig(): Promise<SshKeepaliveConfig> {
  try {
    const cfg = await getUserConfigFromRenderer()
    const keepaliveInterval = (cfg?.sshKeepaliveInterval ?? DEFAULT_KEEPALIVE_INTERVAL) * 1000
    const idleTimeout = (cfg?.sshIdleTimeout ?? DEFAULT_IDLE_TIMEOUT) * 1000

    if (idleTimeout > 0 && keepaliveInterval > 0) {
      const keepaliveCountMax = Math.ceil(idleTimeout / keepaliveInterval)
      return { keepaliveInterval, keepaliveCountMax }
    }

    return { keepaliveInterval, keepaliveCountMax: 3 }
  } catch (error) {
    logger.debug('Failed to read SSH keepalive config, using defaults', { error: error instanceof Error ? error.message : String(error) })
    return { keepaliveInterval: DEFAULT_KEEPALIVE_INTERVAL * 1000, keepaliveCountMax: 3 }
  }
}
