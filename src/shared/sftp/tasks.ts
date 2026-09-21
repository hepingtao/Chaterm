// Shared registry of in-flight transfer tasks, keyed by taskKey.
// The desktop cancel-task IPC handler and the CLI both use cancelActiveTask.

import type { ActiveTaskRecord } from './types'

export const activeTasks = new Map<string, ActiveTaskRecord>()

export const cancelActiveTask = (taskKey: string): { status: 'aborted' | 'not_found' } => {
  const task = activeTasks.get(taskKey)

  if (task) {
    if (task.cancel) {
      task.cancel()
    } else {
      task.read?.destroy?.()
      task.write?.destroy?.()
    }
    activeTasks.delete(taskKey)
    return { status: 'aborted' }
  }
  return { status: 'not_found' }
}
