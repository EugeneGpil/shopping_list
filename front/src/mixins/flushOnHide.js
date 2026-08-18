/**
 * Commit and push out the edit in progress when the app is hidden.
 *
 * An edit is only committed when the field loses focus, so typing and then closing the
 * app — or just switching away from it — would otherwise discard the text with no hint
 * that anything was unsaved. Blurring first runs the ordinary commit path (`change` ->
 * `endEdit` -> scheduled save), so the edit also becomes one undo step exactly as it
 * would have; the flush then pushes it out instead of waiting on the debounce.
 *
 * `visibilitychange` is the signal that actually fires when a phone backgrounds or
 * closes a PWA; `pagehide` covers a desktop tab close.
 *
 * **The component must provide `flushBeforeHide()`** — what to push, and how, is its
 * business; when to do it is this mixin's.
 */
export default {
  mounted() {
    document.addEventListener('visibilitychange', this.persistBeforeHide)
    window.addEventListener('pagehide', this.persistBeforeHide)
  },

  beforeUnmount() {
    document.removeEventListener('visibilitychange', this.persistBeforeHide)
    window.removeEventListener('pagehide', this.persistBeforeHide)
  },

  methods: {
    async persistBeforeHide() {
      if (document.visibilityState !== 'hidden') return
      document.activeElement?.blur?.()
      await this.flushBeforeHide()
    },
  },
}
