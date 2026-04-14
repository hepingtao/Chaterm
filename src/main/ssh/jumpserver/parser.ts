// ssh2jumpserver/parser.ts
const logger = createLogger('jumpserver')

export interface Asset {
  id: number
  name: string
  address: string
  platform: string
  organization: string
  comment: string
}

export interface PaginationInfo {
  currentPage: number
  totalPages: number
}

export interface ParsedOutput {
  assets: Asset[]
  pagination: PaginationInfo
}

export interface JumpServerUser {
  id: number
  name: string
  username: string
}

function parseAssets(output: string): Asset[] {
  const assets: Asset[] = []
  const lines = output.split('\n')
  const assetRegex = /^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*$/

  let foundAssetHeader = false

  for (const line of lines) {
    // Only detect header if not found yet
    if (!foundAssetHeader) {
      const upperLine = line.toUpperCase()

      // Try Chinese header first
      if (line.includes('ID') && (line.includes('名称') || line.includes('地址'))) {
        foundAssetHeader = true
        continue
      }

      // Fallback to English header - use ADDRESS to distinguish from user table
      if (upperLine.includes('ID') && upperLine.includes('ADDRESS') && !upperLine.includes('USERNAME')) {
        foundAssetHeader = true
        continue
      }

      // Generic separator detection
      if (line.includes('-----+--')) {
        foundAssetHeader = true
        continue
      }
    }

    if (foundAssetHeader) {
      const match = line.match(assetRegex)
      if (match) {
        try {
          const asset: Asset = {
            id: parseInt(match[1].trim()),
            name: match[2].trim(),
            address: match[3].trim(),
            platform: match[4].trim(),
            organization: match[5].trim(),
            comment: match[6].trim()
          }
          assets.push(asset)
        } catch (e) {
          logger.debug('Failed to parse asset line', { event: 'jumpserver.parser.asset.error', error: e })
        }
      }
    }
  }
  return assets
}

function parsePagination(output: string): PaginationInfo {
  // Try Chinese format first
  const chineseRegex = /页码：\s*(\d+).*?总页数：\s*(\d+)/
  const chineseMatch = output.match(chineseRegex)
  if (chineseMatch) {
    return {
      currentPage: parseInt(chineseMatch[1], 10),
      totalPages: parseInt(chineseMatch[2], 10)
    }
  }

  // Fallback to English format
  const englishRegex = /Page:\s*(\d+).*?Total Page:\s*(\d+)/
  const englishMatch = output.match(englishRegex)
  if (englishMatch) {
    return {
      currentPage: parseInt(englishMatch[1], 10),
      totalPages: parseInt(englishMatch[2], 10)
    }
  }

  // Default value
  return { currentPage: 1, totalPages: 1 }
}

/**
 * Parse JumpServer raw output
 * @param output JumpServer shell raw output string
 * @returns Parsed assets and pagination information
 */
export function parseJumpserverOutput(output: string): ParsedOutput {
  const assets = parseAssets(output)
  const pagination = parsePagination(output)
  return { assets, pagination }
}

/**
 * Parse JumpServer user list from output
 * @param output JumpServer shell output containing user table
 * @returns Array of parsed users
 */
export function parseJumpServerUsers(output: string): JumpServerUser[] {
  const users: JumpServerUser[] = []
  const lines = output.split(/\r?\n/)
  // Match pattern: ID | NAME | USERNAME (3+ columns) — supports 3 or more pipe-separated columns
  // We capture the first 3 columns (ID, NAME, USERNAME) and ignore the rest
  const userRegex = /^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)(\s*\|.*)?$/

  let foundUserHeader = false
  let consecutiveEmptyLines = 0

  for (const line of lines) {
    const trimmed = line.trim()

    // Detect user table header
    // English: ID | NAME | USERNAME
    // Chinese (or garbled): line contains ID and | characters
    if (!foundUserHeader) {
      if (trimmed.includes('ID') && trimmed.includes('|') && (trimmed.includes('NAME') || trimmed.includes('USERNAME') || trimmed.includes('|'))) {
        // Verify this looks like a header by checking for at least one pipe separator
        const pipeCount = (trimmed.match(/\|/g) || []).length
        if (pipeCount >= 2) {
          foundUserHeader = true
          continue
        }
      }
      // Fallback: detect by separator line followed by data lines
      if (trimmed.match(/^-{4,}\+-{4,}/)) {
        foundUserHeader = true
        continue
      }
      continue
    }

    // Skip separator lines
    if (trimmed.match(/^-{4,}\+-{4,}/)) {
      continue
    }

    // Skip empty lines but don't break — there may be empty lines between user rows
    if (trimmed === '') {
      consecutiveEmptyLines++
      // Only stop after 2+ consecutive empty lines (likely end of table)
      if (consecutiveEmptyLines >= 2) {
        break
      }
      continue
    }
    consecutiveEmptyLines = 0

    // Stop parsing when we hit prompts or non-table content
    if (trimmed.includes('Tips:') || trimmed.includes('Back:') || trimmed.startsWith('ID>')) {
      break
    }

    const match = trimmed.match(userRegex)
    if (match) {
      try {
        const user: JumpServerUser = {
          id: parseInt(match[1].trim()),
          name: match[2].trim(),
          username: match[3].trim()
        }
        users.push(user)
      } catch (e) {
        logger.debug('Failed to parse user line', { event: 'jumpserver.parser.user.error', error: e })
      }
    }
  }

  return users
}

/**
 * Detect if output contains user selection prompt
 * @param output JumpServer shell output
 * @returns true if user selection is required
 */
export function hasUserSelectionPrompt(output: string): boolean {
  // English format: contains account ID, ID, NAME, USERNAME
  if (output.includes('account ID') && output.includes('ID') && output.includes('NAME') && output.includes('USERNAME')) {
    return true
  }

  // ID> prompt indicates JumpServer is waiting for user selection
  // This appears after the user table when multiple accounts exist for an asset
  if (output.includes('ID>')) {
    return true
  }

  // Chinese format with garbled encoding: the table has ID column and separator pattern
  // Check for table structure with ID column (works with both proper and garbled Chinese)
  const lines = output.split(/\r?\n/)
  let hasIdColumn = false
  let hasSeparator = false
  let dataLineCount = 0
  for (const line of lines) {
    const trimmed = line.trim()
    // Header line with ID column
    if (trimmed.includes('ID') && trimmed.includes('|')) {
      hasIdColumn = true
    }
    // Separator line
    if (trimmed.match(/^-{4,}\+-{4,}/)) {
      hasSeparator = true
    }
    // Data line: starts with number followed by |
    if (trimmed.match(/^\s*\d+\s*\|/)) {
      dataLineCount++
    }
  }
  // If we have a table with ID column, separator, and at least one data row,
  // and it's not the initial asset list (which would have Opt> prompt),
  // it's likely a user/account selection table
  if (hasIdColumn && hasSeparator && dataLineCount > 0 && !output.includes('Opt>')) {
    return true
  }

  return false
}
