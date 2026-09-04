//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0
//
// Copyright (c) 2025 cline Authors, All rights reserved.
// Licensed under the Apache License, Version 2.0

import { Anthropic } from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { ApiHandlerOptions, liteLlmDefaultModelId, liteLlmModelInfoSaneDefaults } from '@shared/api'
import { ApiHandler } from '..'
import { ApiStream } from '../transform/stream'
import { convertToOpenAiMessages } from '../transform/openai-format'
import { convertToGlmMessages } from '../transform/glm-format'
import { createProxyAgent, checkProxyConnectivity, resolveSystemProxy, createProxyAgentFromString } from './proxy/index'
import type { Agent } from 'http'
const logger = createLogger('agent')

/**
 * LiteLLM Handler for OpenAI-compatible API with enhanced reasoning support
 *
 * Reasoning/Thinking Data Handling:
 * - Supports multiple field formats for maximum compatibility
 * - Follows OpenAI's Responses API standards where possible
 * - Handles both streaming and non-streaming reasoning content
 *
 * Supported reasoning field formats:
 * 1. delta.reasoning (OpenAI Responses API standard)
 * 2. delta.thinking (legacy format)
 * 3. delta.reasoning_content (some LiteLLM providers)
 *
 *
 * Reference: https://platform.openai.com/docs/guides/reasoning
 * Reference: https://docs.litellm.ai/docs/reasoning_content
 */

export class LiteLlmHandler implements ApiHandler {
  private options: ApiHandlerOptions
  private client: OpenAI
  private currentProxyString: string | null = null // Track current proxy configuration
  private refreshingProxy: Promise<void> | null = null // Mutex lock for concurrent requests

  /**
   * Create LiteLlmHandler synchronously (lazy proxy detection)
   * Proxy will be detected on first request via refreshProxyAgent()
   * @param options - API handler options
   * @returns LiteLlmHandler
   */
  static createSync(options: ApiHandlerOptions): LiteLlmHandler {
    let httpAgent: Agent | undefined = undefined

    // Only apply user-configured proxy immediately
    if (options.needProxy !== false && options.proxyConfig) {
      httpAgent = createProxyAgent(options.proxyConfig)
    }
    // System proxy will be detected lazily on first request

    return new LiteLlmHandler(options, httpAgent)
  }

  private constructor(options: ApiHandlerOptions, httpAgent?: Agent) {
    this.options = options

    // Set timeout, default is 20 seconds, since it will retry 3 times internally, the actual timeout is 60 seconds
    const timeoutMs = this.options.requestTimeoutMs || 20000

    this.client = new OpenAI({
      baseURL: this.options.liteLlmBaseUrl || 'http://localhost:4000',
      apiKey: this.options.liteLlmApiKey || 'noop',
      ...(httpAgent && { fetchOptions: { agent: httpAgent } as any }),
      timeout: timeoutMs // Set timeout (milliseconds)
    })
  }

  /**
   * Refresh proxy agent for dynamic proxy detection
   * Dynamic refreshing adds approximately 10ms to the network burden for each request
   */
  private async refreshProxyAgent(): Promise<void> {
    // If already refreshing, wait for completion to avoid concurrent issues
    if (this.refreshingProxy) {
      return this.refreshingProxy
    }

    // Only refresh when user hasn't configured proxy
    if (this.options.needProxy !== false && !this.options.proxyConfig) {
      this.refreshingProxy = this._doRefreshProxyAgent()
      try {
        await this.refreshingProxy
      } finally {
        this.refreshingProxy = null
      }
    }
  }

  /**
   * Internal method to perform proxy refresh
   * Separated for mutex lock management
   */
  private async _doRefreshProxyAgent(): Promise<void> {
    try {
      const targetUrl = this.options.liteLlmBaseUrl || 'http://localhost:4000'
      const proxyString = await resolveSystemProxy(targetUrl)

      // CRITICAL OPTIMIZATION: Only recreate client when proxy configuration changes
      if (proxyString !== this.currentProxyString) {
        logger.info('[LiteLLM] System proxy changed', { event: 'litellm.proxy.changed', hasProxy: !!proxyString })
        this.currentProxyString = proxyString ?? null

        // Unified proxy agent creation logic
        let httpAgent: Agent | undefined = undefined
        if (proxyString) {
          httpAgent = createProxyAgentFromString(proxyString)
          if (!httpAgent) {
            logger.warn(`[LiteLLM] Failed to create proxy agent, falling back to direct connection`)
          }
        }

        // Single client creation point
        const timeoutMs = this.options.requestTimeoutMs || 20000
        this.client = new OpenAI({
          baseURL: this.options.liteLlmBaseUrl || 'http://localhost:4000',
          apiKey: this.options.liteLlmApiKey || 'noop',
          ...(httpAgent && { fetchOptions: { agent: httpAgent } as any }),
          timeout: timeoutMs
        })

        logger.info(`[LiteLLM] Client recreated with ${httpAgent ? 'system proxy' : 'direct connection'}`)
      }
      // If proxy hasn't changed, do nothing (performance optimization)
    } catch (error) {
      logger.error('[LiteLLM] Failed to refresh proxy agent', { error: error })
      // Fallback: continue using existing client
    }
  }

  async *createMessage(systemPrompt: string, messages: Anthropic.Messages.MessageParam[]): ApiStream {
    // Refresh proxy agent to detect runtime proxy changes
    await this.refreshProxyAgent()

    const modelId = this.options.liteLlmModelId || liteLlmDefaultModelId
    const isGlmModel = modelId.toLowerCase().includes('glm')
    const formattedMessages = isGlmModel ? convertToGlmMessages(messages) : convertToOpenAiMessages(messages)
    const systemMessage: OpenAI.Chat.ChatCompletionSystemMessageParam = {
      role: 'system',
      content: systemPrompt
    }
    const isOminiModel = modelId.includes('o1-mini') || modelId.includes('o3-mini') || modelId.includes('o4-mini')
    const isGpt5OrAbove = modelId.startsWith('gpt-5') || modelId.startsWith('gpt-6')

    // Configuration for extended thinking
    const budgetTokens = 1024
    const isThinkingModel = modelId.endsWith('-Thinking')
    const reasoningOn = isThinkingModel
    const thinkingConfig = reasoningOn ? { type: 'enabled', budget_tokens: budgetTokens } : undefined

    const temperature: number | undefined = this.options.liteLlmModelInfo?.temperature ?? 0
    const supportsTemperature = !(isOminiModel && reasoningOn) && !isGpt5OrAbove

    const cacheControl = { cache_control: { type: 'ephemeral' as const } }

    // Add cache_control to system message if enabled
    const enhancedSystemMessage = {
      ...systemMessage,
      ...(cacheControl && cacheControl)
    }

    // Find the last two user messages to apply caching
    const userMsgIndices = formattedMessages.reduce((acc, msg, index) => (msg.role === 'user' ? [...acc, index] : acc), [] as number[])
    const lastUserMsgIndex = userMsgIndices[userMsgIndices.length - 1] ?? -1
    const secondLastUserMsgIndex = userMsgIndices[userMsgIndices.length - 2] ?? -1

    // Apply cache_control to the last two user messages if enabled
    const enhancedMessages = formattedMessages.map((message, index) => {
      if ((index === lastUserMsgIndex || index === secondLastUserMsgIndex) && cacheControl) {
        return {
          ...message,
          ...cacheControl
        }
      }
      return message
    })

    const params: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.options.liteLlmModelId || liteLlmDefaultModelId,
      messages: [enhancedSystemMessage, ...enhancedMessages],
      ...(supportsTemperature && { temperature }),
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: this.options.liteLlmModelInfo?.maxTokens || 8192
    }

    if (reasoningOn) {
      Object.assign(params, {
        thinking: thinkingConfig,
        enable_thinking: true,
        thinking_budget: budgetTokens
      })
    }

    // Disable native function calling for GLM models: the system prompt uses XML
    // tool tags and the existing parser expects XML-formatted tool calls. Native
    // function calling yields JSON tool_calls that we would have to convert, which
    // adds complexity and has been observed to produce unparseable output. Keep
    // GLM in the same XML-mode path as other models.
    if (isGlmModel) {
      logger.info('[GLM] Native function calling disabled, using XML tool tags', { event: 'glm.xml_tools' })
    }

    const stream = await this.client.chat.completions.create(params)

    let usageInfo: OpenAI.CompletionUsage | undefined | null = undefined
    // GLM models emit inline thinking tags in the content stream:
    // - -Thinking suffix models: <thinking>...</thinking>
    // - hybrid models without the suffix: <think>...</think> when server-side
    //   thinking is enabled
    // Without the parser, thinking streams as plain text and every chunk hits
    // the full-message re-parse in handleTextChunk (O(n^2) in the main
    // process), freezing the app on long thinking. Non-thinking responses
    // pass through the parser unchanged.
    const glmThinkingParser = isGlmModel ? createGlmThinkingParser() : null

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta

      // Handle normal text content
      if (delta?.content) {
        if (glmThinkingParser) {
          const events = glmThinkingParser.process(delta.content)
          for (const event of events) {
            yield event
          }
        } else {
          yield {
            type: 'text',
            text: delta.content
          }
        }
      }

      // Handle reasoning events (thinking)
      // Different providers may use different field names for reasoning content
      // Based on OpenAI's documentation, reasoning data can appear in multiple formats:
      // 1. delta.thinking (legacy format)
      // 2. delta.reasoning_content (some LiteLLM providers)
      // 3. delta.reasoning (OpenAI Responses API format)
      interface ReasoningDelta {
        thinking?: string
        reasoning_content?: string
        reasoning?: string
      }

      const reasoningContent =
        (delta as ReasoningDelta)?.reasoning || (delta as ReasoningDelta)?.thinking || (delta as ReasoningDelta)?.reasoning_content

      if (reasoningContent) {
        yield {
          type: 'reasoning',
          reasoning: reasoningContent
        }
      }

      // Handle token usage information
      if (chunk.usage) {
        usageInfo = chunk.usage
      }
    }

    if (glmThinkingParser) {
      const remainingEvents = glmThinkingParser.flush()
      for (const event of remainingEvents) {
        yield event
      }
    }

    if (usageInfo) {
      // Extract cache-related information if available
      // Need to use type assertion since these properties are not in the standard OpenAI types
      const usage = usageInfo as {
        prompt_tokens: number
        completion_tokens: number
        cache_creation_input_tokens?: number
        prompt_cache_miss_tokens?: number
        cache_read_input_tokens?: number
        prompt_cache_hit_tokens?: number
        reasoning_tokens?: number // Add reasoning tokens support
      }

      const cacheWriteTokens = usage.cache_creation_input_tokens || usage.prompt_cache_miss_tokens || 0
      const cacheReadTokens = usage.cache_read_input_tokens || usage.prompt_cache_hit_tokens || 0

      yield {
        type: 'usage',
        inputTokens: usage.prompt_tokens || 0,
        outputTokens: usage.completion_tokens || 0,
        cacheWriteTokens: cacheWriteTokens > 0 ? cacheWriteTokens : undefined,
        cacheReadTokens: cacheReadTokens > 0 ? cacheReadTokens : undefined,
        reasoningTokens: usage.reasoning_tokens || undefined,
        totalCost: 0
      }
    }
  }

  getModel() {
    return {
      id: this.options.liteLlmModelId || liteLlmDefaultModelId,
      info: this.options.liteLlmModelInfo || liteLlmModelInfoSaneDefaults
    }
  }

  async validateApiKey(): Promise<{ isValid: boolean; error?: string }> {
    try {
      // Validate proxy if configured
      if (this.options.needProxy && this.options.proxyConfig) {
        await checkProxyConnectivity(this.options.proxyConfig)
      }

      // Try to create a minimal chat request to validate the API key
      await this.client.chat.completions.create({
        model: this.options.liteLlmModelId || liteLlmDefaultModelId,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      })

      return { isValid: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        isValid: false,
        error: `Validation failed: ${errorMessage}`
      }
    }
  }
}

type LiteLlmStreamEvent =
  | {
      type: 'text'
      text: string
    }
  | {
      type: 'reasoning'
      reasoning: string
    }

// Streaming helper that splits GLM's inline thinking blocks into incremental reasoning/text events.
// Handles both tag formats GLM emits:
// - <think>...</think> (hybrid models without the -Thinking suffix)
// - <thinking>...</thinking> (-Thinking suffix models)
function createGlmThinkingParser() {
  // Common prefix of both opening tags; a candidate found via indexOf is
  // classified by the characters that follow it.
  const OPEN_PREFIX = '<think'
  const OPEN_LONG = '<thinking>'
  let buffer = ''
  // null = outside thinking; otherwise we are inside that tag's block
  let activeTag: 'think' | 'thinking' | null = null

  const closeTagFor = (tag: 'think' | 'thinking'): string => `</${tag}>`

  // Emits [from, to) as text (skipping empty segments)
  const pushText = (events: LiteLlmStreamEvent[], from: number, to: number) => {
    if (to > from) {
      events.push({ type: 'text', text: buffer.slice(from, to) })
    }
  }

  // Emits the remainder of the buffer as text, holding back a trailing
  // partial open-tag suffix (prefixes of '<thinking>' cover '<think>' too)
  const flushTextWithHoldback = (events: LiteLlmStreamEvent[], from: number): number => {
    const remaining = buffer.slice(from)
    const partialTagLength = getPartialTagSuffixLength(remaining, OPEN_LONG)
    const safeEnd = Math.max(from, buffer.length - partialTagLength)
    if (safeEnd > from) {
      events.push({ type: 'text', text: buffer.slice(from, safeEnd) })
    }
    return safeEnd
  }

  const process = (content: string): LiteLlmStreamEvent[] => {
    buffer += content
    const events: LiteLlmStreamEvent[] = []
    let cursor = 0

    while (cursor < buffer.length) {
      if (activeTag === null) {
        const startIdx = buffer.indexOf(OPEN_PREFIX, cursor)
        if (startIdx === -1) {
          // No tag candidate: emit text, holding back a partial-tag suffix
          const safeEnd = flushTextWithHoldback(events, cursor)
          if (safeEnd <= cursor) {
            break
          }
          cursor = safeEnd
          continue
        }

        const after = startIdx + OPEN_PREFIX.length // char right after '<think'
        if (after >= buffer.length) {
          // Buffer ends mid-candidate ('...<think'): emit text before it and
          // hold the candidate back until more data arrives
          pushText(events, cursor, startIdx)
          cursor = startIdx
          break
        }
        if (buffer[after] === '>') {
          // <think>
          pushText(events, cursor, startIdx)
          activeTag = 'think'
          cursor = after + 1
          continue
        }
        if (buffer.startsWith(OPEN_LONG, startIdx)) {
          // <thinking>
          pushText(events, cursor, startIdx)
          activeTag = 'thinking'
          cursor = startIdx + OPEN_LONG.length
          continue
        }
        if (buffer[after] === 'i' && startIdx + OPEN_LONG.length > buffer.length) {
          // '<thinki…' can still become '<thinking>': hold it back
          pushText(events, cursor, startIdx)
          cursor = startIdx
          break
        }
        // False candidate (e.g. '<thought', '<thinker', '<thinking about'):
        // plain text — resume scanning at the next '<' after it
        const nextLt = buffer.indexOf('<', startIdx + 1)
        if (nextLt === -1) {
          const safeEnd = flushTextWithHoldback(events, cursor)
          if (safeEnd <= cursor) {
            break
          }
          cursor = safeEnd
        } else {
          pushText(events, cursor, nextLt)
          cursor = nextLt
        }
      } else {
        const endTag = closeTagFor(activeTag)
        const endIdx = buffer.indexOf(endTag, cursor)
        if (endIdx === -1) {
          const remaining = buffer.slice(cursor)
          const partialTagLength = getPartialTagSuffixLength(remaining, endTag)
          const safeEnd = Math.max(cursor, buffer.length - partialTagLength)
          if (safeEnd <= cursor) {
            break
          }
          const reasoningSegment = buffer.slice(cursor, safeEnd)
          if (reasoningSegment) {
            events.push({ type: 'reasoning', reasoning: reasoningSegment })
          }
          cursor = safeEnd
        } else {
          const reasoningSegment = buffer.slice(cursor, endIdx)
          if (reasoningSegment) {
            events.push({ type: 'reasoning', reasoning: reasoningSegment })
          }
          cursor = endIdx + endTag.length
          activeTag = null
        }
      }
    }

    buffer = buffer.slice(cursor)
    return events
  }

  const flush = (): LiteLlmStreamEvent[] => {
    if (!buffer) {
      return []
    }
    const events: LiteLlmStreamEvent[] = []
    if (activeTag !== null) {
      events.push({ type: 'reasoning', reasoning: buffer })
    } else {
      events.push({ type: 'text', text: buffer })
    }
    buffer = ''
    activeTag = null
    return events
  }

  return {
    process,
    flush
  }
}

function getPartialTagSuffixLength(segment: string, tag: string): number {
  const maxLength = Math.min(segment.length, tag.length - 1)
  for (let length = maxLength; length > 0; length--) {
    if (segment.endsWith(tag.slice(0, length))) {
      return length
    }
  }
  return 0
}
