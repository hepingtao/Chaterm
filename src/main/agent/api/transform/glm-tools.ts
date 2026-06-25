//  Copyright (c) 2025-present, chaterm.ai  All rights reserved.
//  This source code is licensed under the GPL-3.0

import OpenAI from 'openai'
import { toolMetadata } from '../../core/task/tool-registry'

/**
 * Brief descriptions for each registered tool.
 * Extracted from the system prompt (system.ts) and kept concise for the
 * OpenAI-style `tools` schema. Detailed instructions remain in the system prompt.
 */
const toolDescriptions: Record<string, string> = {
  execute_command: 'Execute a CLI command on a remote server',
  write_to_file: 'Write content to a file on the remote server',
  read_file: 'Read the contents of a file',
  ask_followup_question: 'Ask the user a question to gather additional information',
  attempt_completion: 'Present the final result to the user, completing the task',
  new_task: 'Start a new task with context from the current conversation',
  condense: 'Condense the conversation context',
  report_bug: 'Report a bug with details',
  todo_write: 'Write or update the task todo list',
  todo_read: 'Read the current task todo list',
  glob_search: 'Find files matching a glob pattern',
  grep_search: 'Search file contents with a regex pattern',
  use_mcp_tool: 'Use a tool provided by an MCP server',
  access_mcp_resource: 'Access a resource provided by an MCP server',
  use_skill: 'Use a registered skill by name',
  summarize_to_knowledge: 'Summarize content to the knowledge base',
  summarize_to_skill: 'Summarize content to a skill file',
  kb_search: 'Search the knowledge base for relevant information',
  web_fetch: 'Fetch and extract content from a web URL',
  list_databases: 'List all accessible databases',
  list_schemas: 'List schemas in a database',
  list_tables: 'List tables in a database schema',
  describe_table: 'Describe the structure of a table',
  inspect_indexes: 'Inspect indexes on a table',
  sample_rows: 'Sample rows from a table',
  count_rows: 'Count rows in a table',
  explain_plan: 'Get the execution plan for a SQL query',
  execute_readonly_query: 'Execute a read-only SQL query',
  execute_write_query: 'Execute a write SQL query',
  suggest_indexes: 'Suggest indexes for a table based on query patterns'
}

/**
 * Build OpenAI-style tools schema from the tool registry.
 * Used to enable native function calling for GLM models.
 *
 * All parameters are typed as 'string' to match the XML-tag format
 * where every value is a string (booleans are "true"/"false", etc.).
 * Required parameters are validated by the tool handlers, not the schema.
 */
export function buildGlmToolsSchema(): OpenAI.Chat.ChatCompletionTool[] {
  return toolMetadata.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: toolDescriptions[tool.name] || tool.name,
      parameters: {
        type: 'object',
        properties: tool.paramNames.reduce(
          (acc, param) => {
            acc[param] = { type: 'string', description: param }
            return acc
          },
          {} as Record<string, { type: 'string'; description: string }>
        )
      }
    }
  }))
}

/**
 * Convert an accumulated tool_call (function name + JSON arguments) into
 * XML-tag text that the existing parseAssistantMessageV2 parser can process.
 *
 * This bridges the gap between OpenAI-style function calling responses
 * and Chaterm's XML-tag-based tool parsing pipeline.
 */
export function convertToolCallToXml(name: string, argumentsJson: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    args = {}
  }

  let xml = `<${name}>\n`
  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined) {
      continue
    }
    if (Array.isArray(value)) {
      xml += `<${key}>${value.join(', ')}</${key}>\n`
    } else if (typeof value === 'object') {
      xml += `<${key}>${JSON.stringify(value)}</${key}>\n`
    } else {
      xml += `<${key}>${String(value)}</${key}>\n`
    }
  }
  xml += `</${name}>`
  return xml
}
