//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0
//
// Copyright (c) 2025 cline Authors, All rights reserved.
// Licensed under the Apache License, Version 2.0

import type { BrowserWindow } from 'electron'
import type { GlobalStateKey, SecretKey, ApiConfiguration, ApiProvider } from './types'
import { getCurrentUserId, getGuestUserId } from '@storage/db/connection'
import { ChatermDatabaseService } from '@storage/db/chaterm.service'

export interface ModelOption {
  id: string
  name: string
  checked: boolean
  type: string
  apiProvider: string
}

const logger = createLogger('agent')

// Keep window reference for backward compatibility (external callers may still
// reference initializeStorageMain, though storage no longer depends on it).
let mainWindow: BrowserWindow | null = null

export function initializeStorageMain(window: BrowserWindow): void {
  mainWindow = window
  void mainWindow
  logger.info('[Main] Storage initialized - using direct KV access.')
}

// ─── Internal KV helpers ──────────────────────────────────────────────────────

async function getDbInstance(): Promise<ChatermDatabaseService> {
  const userId = getCurrentUserId() || getGuestUserId()
  return await ChatermDatabaseService.getInstance(userId)
}

async function kvRead(key: string): Promise<any> {
  try {
    const db = await getDbInstance()
    const row = db.getKeyValue(key)
    if (row?.value) {
      const { deserializeStoredKvValue } = await import('@storage/db/kv-serialization')
      const result = await deserializeStoredKvValue(row.value)
      return result.value
    }
    return undefined
  } catch (error) {
    logger.error(`kvRead failed for ${key}`, { error: error })
    return undefined
  }
}

async function kvWrite(key: string, value: any): Promise<void> {
  try {
    const db = await getDbInstance()
    db.setKeyValue({ key, value: JSON.stringify(value) })
  } catch (error) {
    logger.error(`kvWrite failed for ${key}`, { error: error })
  }
}

async function kvDelete(key: string): Promise<void> {
  try {
    const db = await getDbInstance()
    db.deleteKeyValue(key)
  } catch (error) {
    logger.error(`kvDelete failed for ${key}`, { error: error })
  }
}

// ─── Global State ──────────────────────────────────────────────────────────────

export async function getGlobalState(key: GlobalStateKey): Promise<any> {
  return kvRead(`global_${key}`)
}

export async function updateGlobalState(key: GlobalStateKey, value: any): Promise<void> {
  return kvWrite(`global_${key}`, value)
}

// ─── Secrets ───────────────────────────────────────────────────────────────────

export async function getSecret(key: SecretKey): Promise<string | undefined> {
  return kvRead(`secret_${key}`)
}

export async function storeSecret(key: SecretKey, value?: string): Promise<void> {
  if (value !== undefined) {
    return kvWrite(`secret_${key}`, value)
  } else {
    return kvDelete(`secret_${key}`)
  }
}

// ─── Workspace State ──────────────────────────────────────────────────────────

export async function getWorkspaceState(key: string): Promise<any> {
  return kvRead(`workspace_${key}`)
}

export async function updateWorkspaceState(key: string, value: any): Promise<void> {
  return kvWrite(`workspace_${key}`, value)
}

// ─── All Extension State (replicates renderer's logic using direct KV access) ─

export async function getAllExtensionState(): Promise<any> {
  try {
    const [
      storedApiProvider,
      apiModelId,
      apiKey,
      awsAccessKey,
      awsSecretKey,
      awsSessionToken,
      awsRegion,
      awsUseCrossRegionInference,
      awsBedrockUsePromptCache,
      awsBedrockEndpoint,
      awsProfile,
      awsUseProfile,
      awsBedrockCustomSelected,
      awsBedrockCustomModelBaseId,
      openAiBaseUrl,
      openAiApiKey,
      openAiModelId,
      openAiModelInfo,
      ollamaModelId,
      ollamaBaseUrl,
      ollamaApiOptionsCtxNum,
      deepSeekApiKey,
      anthropicApiKey,
      anthropicBaseUrl,
      anthropicModelId,
      customInstructions,
      userRules,
      autoApprovalSettings,
      chatSettings,
      liteLlmBaseUrl,
      liteLlmModelId,
      liteLlmApiKey,
      userInfo,
      previousModeApiProvider,
      previousModeModelId,
      previousModeModelInfo,
      previousModeThinkingBudgetTokens,
      previousModeReasoningEffort,
      previousModeAwsBedrockCustomSelected,
      previousModeAwsBedrockCustomModelBaseId,
      telemetrySetting,
      thinkingBudgetTokens,
      reasoningEffort,
      favoritedModelIds,
      requestTimeoutMs,
      shellIntegrationTimeout,
      needProxy,
      proxyConfig,
      defaultBaseUrl,
      defaultModelId,
      defaultApiKey,
      defaultModelInfoMap
    ] = await Promise.all([
      getGlobalState('apiProvider'),
      getGlobalState('apiModelId'),
      getSecret('apiKey'),
      getSecret('awsAccessKey'),
      getSecret('awsSecretKey'),
      getSecret('awsSessionToken'),
      getGlobalState('awsRegion'),
      getGlobalState('awsUseCrossRegionInference'),
      getGlobalState('awsBedrockUsePromptCache'),
      getGlobalState('awsBedrockEndpoint'),
      getGlobalState('awsProfile'),
      getGlobalState('awsUseProfile'),
      getGlobalState('awsBedrockCustomSelected'),
      getGlobalState('awsBedrockCustomModelBaseId'),
      getGlobalState('openAiBaseUrl'),
      getSecret('openAiApiKey'),
      getGlobalState('openAiModelId'),
      getGlobalState('openAiModelInfo'),
      getGlobalState('ollamaModelId'),
      getGlobalState('ollamaBaseUrl'),
      getGlobalState('ollamaApiOptionsCtxNum'),
      getSecret('deepSeekApiKey'),
      getSecret('anthropicApiKey'),
      getGlobalState('anthropicBaseUrl'),
      getGlobalState('anthropicModelId'),
      getGlobalState('customInstructions'),
      getGlobalState('userRules'),
      getGlobalState('autoApprovalSettings'),
      getGlobalState('chatSettings'),
      getGlobalState('liteLlmBaseUrl'),
      getGlobalState('liteLlmModelId'),
      getSecret('liteLlmApiKey'),
      getGlobalState('userInfo'),
      getGlobalState('previousModeApiProvider'),
      getGlobalState('previousModeModelId'),
      getGlobalState('previousModeModelInfo'),
      getGlobalState('previousModeThinkingBudgetTokens'),
      getGlobalState('previousModeReasoningEffort'),
      getGlobalState('previousModeAwsBedrockCustomSelected'),
      getGlobalState('previousModeAwsBedrockCustomModelBaseId'),
      getGlobalState('telemetrySetting'),
      getGlobalState('thinkingBudgetTokens'),
      getGlobalState('reasoningEffort'),
      getGlobalState('favoritedModelIds'),
      getGlobalState('requestTimeoutMs'),
      getGlobalState('shellIntegrationTimeout'),
      getGlobalState('needProxy'),
      getGlobalState('proxyConfig'),
      getGlobalState('defaultBaseUrl'),
      getGlobalState('defaultModelId'),
      getSecret('defaultApiKey'),
      getGlobalState('defaultModelInfoMap')
    ])

    const apiProvider: ApiProvider = storedApiProvider || 'bedrock'

    return {
      apiConfiguration: {
        apiProvider,
        apiModelId,
        apiKey,
        awsAccessKey,
        awsSecretKey,
        awsSessionToken,
        awsRegion,
        awsUseCrossRegionInference,
        awsBedrockUsePromptCache,
        awsBedrockEndpoint,
        awsProfile,
        awsUseProfile,
        awsBedrockCustomSelected,
        awsBedrockCustomModelBaseId,
        openAiBaseUrl,
        openAiApiKey,
        openAiModelId,
        openAiModelInfo,
        ollamaModelId,
        ollamaBaseUrl,
        ollamaApiOptionsCtxNum,
        deepSeekApiKey,
        anthropicApiKey,
        anthropicBaseUrl,
        anthropicModelId,
        o3MiniReasoningEffort: 'medium',
        thinkingBudgetTokens,
        reasoningEffort,
        liteLlmBaseUrl,
        liteLlmModelId,
        liteLlmApiKey,
        favoritedModelIds,
        requestTimeoutMs,
        needProxy,
        proxyConfig,
        defaultBaseUrl,
        defaultModelId,
        defaultApiKey,
        defaultModelInfoMap
      },
      customInstructions,
      userRules,
      autoApprovalSettings: autoApprovalSettings || {
        version: 1,
        enabled: false,
        actions: {
          readFiles: true,
          readFilesExternally: false,
          editFiles: false,
          editFilesExternally: false,
          executeSafeCommands: true,
          executeAllCommands: false,
          useBrowser: false,
          useMcp: false
        },
        maxRequests: 0,
        enableNotifications: false,
        favorites: []
      },
      chatSettings: chatSettings || { mode: 'agent' },
      userInfo,
      previousModeApiProvider,
      previousModeModelId,
      previousModeModelInfo,
      previousModeThinkingBudgetTokens,
      previousModeReasoningEffort,
      previousModeAwsBedrockCustomSelected,
      previousModeAwsBedrockCustomModelBaseId,
      mcpMarketplaceEnabled: true,
      telemetrySetting: telemetrySetting || 'unset',
      shellIntegrationTimeout: shellIntegrationTimeout || 4000
    }
  } catch (error) {
    logger.error('Failed to get all extension state', { error: error })
    return {}
  }
}

// ─── Update API Configuration ──────────────────────────────────────────────────

export async function updateApiConfiguration(config: ApiConfiguration): Promise<void> {
  const {
    apiProvider,
    apiModelId,
    awsAccessKey,
    awsSecretKey,
    awsSessionToken,
    awsRegion,
    awsUseCrossRegionInference,
    awsBedrockUsePromptCache,
    awsBedrockEndpoint,
    awsProfile,
    awsUseProfile,
    thinkingBudgetTokens,
    reasoningEffort,
    liteLlmBaseUrl,
    liteLlmModelId,
    liteLlmApiKey,
    favoritedModelIds,
    deepSeekApiKey,
    anthropicApiKey,
    anthropicBaseUrl,
    anthropicModelId,
    openAiBaseUrl,
    openAiApiKey,
    openAiModelId,
    openAiModelInfo,
    ollamaModelId,
    ollamaBaseUrl,
    ollamaApiOptionsCtxNum,
    defaultBaseUrl,
    defaultModelId,
    defaultApiKey
  } = config

  await Promise.all([
    updateGlobalState('apiProvider', apiProvider),
    updateGlobalState('apiModelId', apiModelId),
    storeSecret('awsAccessKey', awsAccessKey),
    storeSecret('awsSecretKey', awsSecretKey),
    storeSecret('awsSessionToken', awsSessionToken),
    updateGlobalState('awsRegion', awsRegion),
    updateGlobalState('awsUseCrossRegionInference', awsUseCrossRegionInference),
    updateGlobalState('awsBedrockUsePromptCache', awsBedrockUsePromptCache),
    updateGlobalState('awsBedrockEndpoint', awsBedrockEndpoint),
    updateGlobalState('awsProfile', awsProfile),
    updateGlobalState('awsUseProfile', awsUseProfile),
    updateGlobalState('openAiBaseUrl', openAiBaseUrl),
    storeSecret('openAiApiKey', openAiApiKey),
    updateGlobalState('openAiModelId', openAiModelId),
    updateGlobalState('openAiModelInfo', openAiModelInfo),
    updateGlobalState('ollamaModelId', ollamaModelId),
    updateGlobalState('ollamaBaseUrl', ollamaBaseUrl),
    updateGlobalState('ollamaApiOptionsCtxNum', ollamaApiOptionsCtxNum),
    storeSecret('deepSeekApiKey', deepSeekApiKey),
    storeSecret('anthropicApiKey', anthropicApiKey),
    updateGlobalState('anthropicBaseUrl', anthropicBaseUrl),
    updateGlobalState('anthropicModelId', anthropicModelId),
    storeSecret('liteLlmApiKey', liteLlmApiKey),
    updateGlobalState('liteLlmBaseUrl', liteLlmBaseUrl),
    updateGlobalState('liteLlmModelId', liteLlmModelId),
    updateGlobalState('thinkingBudgetTokens', thinkingBudgetTokens),
    updateGlobalState('reasoningEffort', reasoningEffort),
    updateGlobalState('favoritedModelIds', favoritedModelIds),
    updateGlobalState('requestTimeoutMs', config.requestTimeoutMs),
    updateGlobalState('needProxy', config.needProxy),
    updateGlobalState('proxyConfig', config.proxyConfig),
    updateGlobalState('defaultBaseUrl', defaultBaseUrl),
    updateGlobalState('defaultModelId', defaultModelId),
    storeSecret('defaultApiKey', defaultApiKey)
  ])
}

// ─── Reset Extension State ────────────────────────────────────────────────────

export async function resetExtensionState(): Promise<void> {
  try {
    const db = await getDbInstance()
    const allKeys = db.getAllKeys()

    const operations: Array<Promise<void>> = []
    for (const key of allKeys) {
      if (key.startsWith('global_') || key.startsWith('secret_') || key.startsWith('workspace_')) {
        operations.push(kvDelete(key))
      }
    }
    await Promise.all(operations)
  } catch (error) {
    logger.error('resetExtensionState failed', { error: error })
  }
}

// ─── User ID (from main process) ──────────────────────────────────────────────

export async function getUserId(): Promise<any> {
  try {
    const userId = getCurrentUserId()
    return userId || null
  } catch (error) {
    return null
  }
}

// ─── User Config (from KV store, no window dependency) ────────────────────────

export async function getUserConfig(): Promise<any> {
  try {
    const config = await kvRead('userConfig')
    return (
      config || {
        language: 'zh-CN',
        aliasStatus: 2,
        uid: 0,
        autoCompleteStatus: 2,
        commonVimStatus: 2,
        quickVimStatus: 2,
        cursorStyle: 'bar',
        fontSize: 12,
        highlightStatus: 2,
        scrollBack: 1000,
        watermark: 'open',
        secretRedaction: 'disabled',
        dataSync: 'disabled',
        feature: 0.0,
        terminalType: 'xterm',
        theme: 'dark',
        background: {
          image: '',
          opacity: 0.15,
          brightness: 0.45,
          mode: 'none'
        }
      }
    )
  } catch (error) {
    logger.error('getUserConfig failed', { error: error })
    return { language: 'zh-CN' }
  }
}

// ─── Model Options ────────────────────────────────────────────────────────────

export async function getModelOptions(excludeThinking = false): Promise<ModelOption[]> {
  try {
    const modelOptions = await kvRead('global_modelOptions')
    if (!Array.isArray(modelOptions)) {
      return []
    }

    if (excludeThinking) {
      return modelOptions.filter((model: ModelOption) => !model.name.endsWith('-Thinking'))
    }

    return modelOptions
  } catch (error) {
    logger.error('getModelOptions failed', { error: error })
    return []
  }
}

// ─── Test (kept for backward compatibility) ────────────────────────────────────

export async function testStorageFromMain(): Promise<void> {
  logger.info('[Main Storage Test] Using direct KV access mode.')
}
