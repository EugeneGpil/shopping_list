import { onMounted, onBeforeUnmount } from 'vue'

/**
 * Commit and push out the edit in progress when the app is hidden.
 *
 * An edit is only committed when the field loses focus, so typing and then closing the
 * app — or just switching away from it — would otherwise discard the text with no hint
 * that anything was unsaved. Blurring first runs the ordinary commit path (`change` ->
 * `endEdit` -> scheduled save), so the edit also becomes one undo step exactly as it
 * would have; `flush` then pushes it out instead of waiting on the debounce.
 *
 * `visibilitychange` is the signal that actually fires when a phone backgrounds or
 * closes a PWA; `pagehide` covers a desktop tab close.
 */
export function useFlushOnHide(flush) {
  async function persistBeforeHide() {
    if (document.visibilityState !== 'hidden') return
    document.activeElement?.blur?.()
    await flush()
  }

  onMounted(() => {
    document.addEventListener('visibilitychange', persistBeforeHide)
    window.addEventListener('pagehide', persistBeforeHide)
  })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', persistBeforeHide)
    window.removeEventListener('pagehide', persistBeforeHide)
  })
}
