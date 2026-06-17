import os, sys
os.chdir(r'D:\work\github\Chaterm')
sys.stdout.reconfigure(encoding='utf-8')

with open(r'..\useChatMessages.ours.ts', 'r', encoding='utf-8') as f:
    ours = f.read()

lines = ours.split('\n')

# 1. Add workspace import after last import
last_import_idx = 0
for i, l in enumerate(lines):
    if l.strip().startswith('import ') or l.strip().startswith('import type '):
        last_import_idx = i
print('Last import at line', last_import_idx+1)

ws_import = "import { AI_TAB_DEFAULT_WORKSPACE, type AiTabWorkspace } from '../workspace'"
lines.insert(last_import_idx + 1, ws_import)

# 2. Add AiTabDbContext interface before function
fn_idx = 0
for i, l in enumerate(lines):
    if l.strip().startswith('export function useChatMessages('):
        fn_idx = i
        break

ctx_iface = '''/**
 * Per-AiTab context that must be threaded into outgoing Task messages when
 * the AiTab is mounted in the Database workspace (task #18 Stage 1).
 *
 * Shape mirrors docs/database_ai.md \u00a79.2 `dbContext`; the canonical type
 * lives in `@common/db-ai-types` but is intentionally duplicated here as
 * a plain object literal so useChatMessages does not grow a hard dep on
 * the main-side `@shared` alias (kept testable in isolation).
 */
export interface AiTabDbContext {
  assetId: string
  dbType: 'mysql' | 'postgresql'
  databaseName?: string
  schemaName?: string
  assetName?: string
}'''

lines[fn_idx:fn_idx] = ctx_iface.split('\n')
print('Inserted interface at line', fn_idx+1)

# 3. Update function signature - add comma after checkModelConfig
for i, l in enumerate(lines):
    if 'checkModelConfig:' in l and l.strip().endswith('>'):
        lines[i] = l.rstrip() + ','
        break

# Write result to a temp first, then compare
result = '\n'.join(lines)
with open('src/renderer/src/views/components/AiTab/composables/useChatMessages.ts', 'w', encoding='utf-8') as f:
    f.write(result)

print('Done:', len(lines), 'lines')
