//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0
//
// Copyright (c) 2025 cline Authors, All rights reserved.
// Licensed under the Apache License, Version 2.0

export type ApiProvider = 'anthropic' | 'bedrock' | 'litellm' | 'deepseek' | 'default' | 'openai' | 'ollama'

export type GlobalStateKey =
  | 'apiProvider'
  | 'apiModelId'
  | 'awsRegion'
  | 'awsUseCrossRegionInference'
  | 'awsBedrockUsePromptCache'
  | 'awsBedrockEndpoint'
  | 'awsProfile'
  | 'awsUseProfile'
  | 'awsBedrockCustomSelected'
  | 'awsBedrockCustomModelBaseId'
  | 'customInstructions'
  | 'userRules'
  | 'autoApprovalSettings'
  | 'chatSettings'
  | 'userInfo'
  | 'previousModeApiProvider'
  | 'previousModeModelId'
  | 'previousModeModelInfo'
  | 'previousModeThinkingBudgetTokens'
  | 'previousModeReasoningEffort'
  | 'previousModeAwsBedrockCustomSelected'
  | 'previousModeAwsBedrockCustomModelBaseId'
  | 'telemetrySetting'
  | 'thinkingBudgetTokens'
  | 'reasoningEffort'
  | 'favoritedModelIds'
  | 'requestTimeoutMs'
  | 'shellIntegrationTimeout'
  | 'mcpMarketplaceEnabled'
  | 'kbSearchEnabled'
  | 'experienceExtractionEnabled'
  | 'openAiBaseUrl'
  | 'openAiModelId'
  | 'openAiModelInfo'
  | 'ollamaModelId'
  | 'ollamaBaseUrl'
  | 'ollamaApiOptionsCtxNum'
  | 'anthropicBaseUrl'
  | 'anthropicModelId'
  | 'liteLlmBaseUrl'
  | 'liteLlmModelId'
  | 'needProxy'
  | 'proxyConfig'
  | 'defaultBaseUrl'
  | 'defaultModelId'
  | 'defaultModelInfoMap'
  | 'testGlobalKey' // For testing

export type SecretKey =
  | 'apiKey'
  | 'openRouterApiKey'
  | 'awsAccessKey'
  | 'awsSecretKey'
  | 'awsSessionToken'
  | 'openAiApiKey'
  | 'geminiApiKey'
  | 'openAiNativeApiKey'
  | 'deepSeekApiKey'
  | 'requestyApiKey'
  | 'togetherApiKey'
  | 'qwenApiKey'
  | 'doubaoApiKey'
  | 'mistralApiKey'
  | 'clineApiKey'
  | 'liteLlmApiKey'
  | 'fireworksApiKey'
  | 'asksageApiKey'
  | 'xaiApiKey'
  | 'sambanovaApiKey'
  | 'defaultApiKey'
  | 'anthropicApiKey'
  | 'testSecretKey' // For testing

export interface ApiHandlerOptions {
  apiModelId?: string
  taskId?: string
  apiKey?: string
  awsAccessKey?: string
  awsSecretKey?: string
  awsSessionToken?: string
  awsRegion?: string
  awsUseCrossRegionInference?: boolean
  awsBedrockUsePromptCache?: boolean
  awsUseProfile?: boolean
  awsProfile?: string
  awsBedrockEndpoint?: string
  thinkingBudgetTokens?: number
  reasoningEffort?: string
  requestTimeoutMs?: number
  onRetryAttempt?: (attempt: number, maxRetries: number, delay: number, error: any) => void
  // Additional API provider fields (for getAllExtensionState round-trip)
  openAiBaseUrl?: string
  openAiApiKey?: string
  openAiModelId?: string
  openAiModelInfo?: Record<string, unknown>
  ollamaModelId?: string
  ollamaBaseUrl?: string
  ollamaApiOptionsCtxNum?: string
  deepSeekApiKey?: string
  anthropicApiKey?: string
  anthropicBaseUrl?: string
  anthropicModelId?: string
  liteLlmBaseUrl?: string
  liteLlmModelId?: string
  liteLlmApiKey?: string
  defaultBaseUrl?: string
  defaultModelId?: string
  defaultApiKey?: string
  defaultModelInfoMap?: Record<string, { contextWindow?: number; maxTokens?: number } | undefined>
  needProxy?: boolean
  proxyConfig?: { type?: string; host?: string; port?: number; enableProxyIdentity?: boolean; username?: string; password?: string }
  o3MiniReasoningEffort?: string
}

export type ApiConfiguration = ApiHandlerOptions & {
  apiProvider?: ApiProvider
  favoritedModelIds?: string[]
}
