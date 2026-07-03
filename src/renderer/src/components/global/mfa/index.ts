export { default as MfaDialog } from './MfaDialog.vue'

export {
  showOtpDialog,
  showOtpDialogErr,
  showOtpDialogCheckErr,
  otpPrompt,
  otpCode,
  currentOtpId,
  currentOtpHost,
  otpTimeRemaining,
  otpAttempts,
  showSaveOtpSection,
  otpSecretInput,
  savingOtpSecret,
  otpSecretSaved,
  handleOtpRequest,
  handleOtpTimeout,
  handleOtpError,
  submitOtpCode,
  cancelOtp,
  resetOtpDialog,
  toggleSaveOtpSection,
  saveOtpSecret
} from './mfaState'

const logger = createRendererLogger('mfa')

export const setupGlobalMfaListeners = () => {
  const api = (window as any).api
  if (api) {
    logger.info('Setting up global MFA listeners')
    api.onKeyboardInteractiveRequest(handleOtpRequest)
    api.onKeyboardInteractiveTimeout(handleOtpTimeout)
    api.onKeyboardInteractiveResult(handleOtpError)
  }
}

import { handleOtpRequest, handleOtpTimeout, handleOtpError } from './mfaState'
