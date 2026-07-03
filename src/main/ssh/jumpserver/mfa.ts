import { ipcMain } from 'electron'
import { keyboardInteractiveOpts } from '../sshHandle'
import { generateOtpForHost } from '../otp/otpStore'

const mfaLogger = createLogger('jumpserver-mfa')

export const handleJumpServerKeyboardInteractive = (event, id, prompts, finish, host?: string) => {
  return new Promise<void>((resolve, reject) => {
    ;(async () => {
      // Try to auto-fill OTP from the secret store before showing the dialog
      if (host) {
        try {
          const otpCode = await generateOtpForHost(host)
          if (otpCode) {
            mfaLogger.info('Auto-filling OTP from saved secret', {
              event: 'jumpserver.mfa.otp-autofill',
              id,
              host
            })
            finish([otpCode])
            keyboardInteractiveOpts.set(id, [otpCode])
            resolve()
            return
          }
        } catch (otpError) {
          mfaLogger.warn('Failed to auto-fill OTP, falling back to manual input', {
            event: 'jumpserver.mfa.otp-autofill.failed',
            id,
            host,
            error: otpError instanceof Error ? otpError.message : String(otpError)
          })
        }
      }

      event.sender.send('ssh:keyboard-interactive-request', {
        id,
        prompts: prompts.map((p) => p.prompt),
        host: host || null
      })

      const timeoutId = setTimeout(() => {
        ipcMain.removeAllListeners(`ssh:keyboard-interactive-response:${id}`)
        ipcMain.removeAllListeners(`ssh:keyboard-interactive-cancel:${id}`)
        finish([])
        event.sender.send('ssh:keyboard-interactive-timeout', { id })
        reject(new Error('Two-factor authentication timeout'))
      }, 180000)

      ipcMain.once(`ssh:keyboard-interactive-response:${id}`, (_evt, responses) => {
        clearTimeout(timeoutId)
        finish(responses)
        keyboardInteractiveOpts.set(id, responses)
        resolve()
      })

      ipcMain.once(`ssh:keyboard-interactive-cancel:${id}`, () => {
        clearTimeout(timeoutId)
        finish([])
        reject(new Error('User cancelled two-factor authentication'))
      })
    })().catch(reject)
  })
}
