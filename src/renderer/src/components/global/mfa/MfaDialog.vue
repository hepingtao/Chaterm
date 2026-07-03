<template>
  <a-modal
    v-model:visible="showOtpDialog"
    :title="$t('mfa.title')"
    width="400px"
    :mask-closable="false"
    :keyboard="false"
    :footer="null"
    class="mfa-modal"
    @cancel="cancelOtp"
  >
    <div class="mfa-content">
      <div class="otp-section">
        <div
          v-if="otpPrompt"
          class="prompt-section"
        >
          <span class="prompt-text">{{ otpPrompt }}</span>
        </div>
        <OtpInput
          v-model="otpCode"
          :has-error="showOtpDialogErr || showOtpDialogCheckErr"
          :error-message="getErrorMessage()"
          @complete="handleOtpComplete"
          @change="handleOtpChange"
        />
      </div>

      <!-- Save OTP secret section -->
      <div
        v-if="currentOtpHost && !otpSecretSaved"
        class="save-otp-toggle"
      >
        <a
          href="javascript:void(0)"
          class="save-otp-link"
          @click="toggleSaveOtpSection"
        >
          {{ showSaveOtpSection ? $t('mfa.cancelSaveOtp') : $t('mfa.saveOtpForAutoFill') }}
        </a>
      </div>
      <div
        v-if="showSaveOtpSection && currentOtpHost"
        class="save-otp-section"
      >
        <input
          v-model="otpSecretInput"
          type="text"
          class="otp-secret-input"
          :placeholder="$t('mfa.otpSecretPlaceholder')"
          :disabled="savingOtpSecret"
        />
        <button
          class="save-otp-btn"
          :disabled="savingOtpSecret || !otpSecretInput.trim()"
          @click="saveOtpSecret"
        >
          {{ savingOtpSecret ? $t('mfa.saving') : $t('mfa.save') }}
        </button>
      </div>
      <div
        v-if="otpSecretSaved"
        class="otp-saved-hint"
      >
        {{ $t('mfa.otpSecretSavedHint') }}
      </div>

      <div class="timer-section">
        <span class="timer-text"> {{ $t('mfa.remainingTime') }}: {{ Math.ceil(otpTimeRemaining / 1000) }}s </span>
      </div>
    </div>
  </a-modal>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import OtpInput from './OtpInput.vue'
import {
  showOtpDialog,
  showOtpDialogErr,
  showOtpDialogCheckErr,
  otpPrompt,
  otpCode,
  otpTimeRemaining,
  currentOtpHost,
  showSaveOtpSection,
  otpSecretInput,
  savingOtpSecret,
  otpSecretSaved,
  cancelOtp,
  handleOtpChange,
  handleOtpComplete,
  toggleSaveOtpSection,
  saveOtpSecret
} from './mfaState'

const { t } = useI18n()

// Error message helper
const getErrorMessage = () => {
  if (showOtpDialogCheckErr.value) {
    return t('mfa.pleaseInputVerificationCode')
  }
  if (showOtpDialogErr.value) {
    return t('mfa.verificationCodeError')
  }
  return ''
}
</script>

<style scoped>
.mfa-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 20px 0 32px 0;
  gap: 24px;
}

.otp-section {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  gap: 16px;
}

.prompt-section {
  width: 100%;
  display: flex;
  justify-content: center;
}

.prompt-text {
  color: var(--text-color-secondary-light);
  font-size: 14px;
  text-align: center;
  white-space: pre-wrap;
}

.timer-section {
  display: flex;
  justify-content: center;
  width: 100%;
}

.timer-text {
  color: var(--text-color-secondary-light);
  font-size: 13px;
  font-weight: normal;
}

.save-otp-toggle {
  width: 100%;
  text-align: center;
}

.save-otp-link {
  color: #4096ff;
  font-size: 13px;
  text-decoration: none;
}

.save-otp-link:hover {
  text-decoration: underline;
}

.save-otp-section {
  display: flex;
  gap: 8px;
  width: 100%;
}

.otp-secret-input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border-color-light);
  border-radius: 6px;
  background-color: var(--bg-color);
  color: var(--text-color);
  font-size: 13px;
  outline: none;
}

.otp-secret-input:focus {
  border-color: #4096ff;
  box-shadow: 0 0 0 2px rgba(5, 145, 255, 0.2);
}

.save-otp-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 6px;
  background-color: #4096ff;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.2s;
}

.save-otp-btn:hover:not(:disabled) {
  background-color: #1677ff;
}

.save-otp-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.otp-saved-hint {
  color: #52c41a;
  font-size: 13px;
  text-align: center;
}

/* Mobile responsive */
@media (max-width: 480px) {
  .mfa-content {
    padding: 16px 0 24px 0;
    gap: 20px;
  }

  .prompt-text {
    font-size: 13px;
  }

  .timer-text {
    font-size: 12px;
  }

  .save-otp-section {
    flex-direction: column;
  }
}
</style>

<style>
/* Use global style so it works with teleported AntD modal */
.mfa-modal .ant-modal-content {
  background-color: var(--bg-color-secondary) !important;
  color: var(--text-color) !important;
  border: 1px solid var(--border-color-light) !important;
}

.mfa-modal .ant-modal-header {
  background-color: var(--bg-color-secondary) !important;
  border-bottom: 1px solid var(--border-color-light) !important;
}

.mfa-modal .ant-modal-title {
  color: var(--text-color) !important;
}

.mfa-modal .ant-modal-close,
.mfa-modal .ant-modal-close-x,
.mfa-modal .ant-modal-close .ant-modal-close-icon {
  color: var(--text-color-secondary-light) !important;
}

.mfa-modal .ant-modal-body {
  background-color: var(--bg-color-secondary) !important;
}
</style>
