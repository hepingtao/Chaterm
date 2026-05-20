import { onMounted, onUnmounted, watch, type Ref } from 'vue'

/**
 * Composable for multi-window AI support.
 *
 * - Registers the current window as the AI-bound window when AI sidebar is active,
 *   so AI responses are always routed here even when the user switches to another window.
 * - Provides createTerminalWindow() to spawn a terminal-only window.
 */
export function useMultiWindowAi(showAiSidebar: Ref<boolean>) {
  let registered = false

  const register = (): void => {
    if (registered) return
    window.api.registerAiWindow()
    registered = true
  }

  const unregister = (): void => {
    if (!registered) return
    window.api.unregisterAiWindow()
    registered = false
  }

  // Watch AI sidebar visibility to register/unregister as AI-bound window
  const stopWatch = watch(showAiSidebar, (visible) => {
    if (visible) {
      register()
    } else {
      unregister()
    }
  })

  onMounted(() => {
    if (showAiSidebar.value) {
      register()
    }
  })

  onUnmounted(() => {
    stopWatch()
    unregister()
  })

  const createTerminalWindow = async (): Promise<void> => {
    try {
      await window.api.createTerminalWindow()
    } catch (error) {
      console.error('[MultiWindowAi] Failed to create terminal window', error)
    }
  }

  return {
    createTerminalWindow
  }
}
