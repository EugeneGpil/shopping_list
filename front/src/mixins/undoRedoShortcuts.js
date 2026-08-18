/**
 * Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo, routed to the component's
 * own `undo()` and `redo()`.
 *
 * Bound on `window` rather than on a field, because the shortcut has to work wherever
 * the caret is — including nowhere. Bound only for as long as the component using this is
 * mounted, so no other page can undo into a list it is not showing.
 */
export default {
  mounted() {
    window.addEventListener('keydown', this.onUndoRedoKey)
  },

  beforeUnmount() {
    window.removeEventListener('keydown', this.onUndoRedoKey)
  },

  methods: {
    onUndoRedoKey(e) {
      if (!(e.ctrlKey || e.metaKey)) return
      const k = e.key.toLowerCase()
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault()
        this.undo()
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault()
        this.redo()
      }
    },
  },
}
