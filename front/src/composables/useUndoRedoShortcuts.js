import { onMounted, onBeforeUnmount } from 'vue'

/**
 * Ctrl/Cmd+Z to undo, Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y to redo.
 *
 * Bound on `window` rather than on a field, because the shortcut has to work wherever
 * the caret is — including nowhere. Bound only for as long as the calling component is
 * mounted, so no other page can undo into a list it is not showing.
 *
 * Takes the two actions rather than the store, so what it touches is visible here.
 */
export function useUndoRedoShortcuts({ undo, redo }) {
  function onKey(e) {
    if (!(e.ctrlKey || e.metaKey)) return
    const k = e.key.toLowerCase()
    if (k === 'z' && !e.shiftKey) {
      e.preventDefault()
      undo()
    } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
      e.preventDefault()
      redo()
    }
  }

  onMounted(() => window.addEventListener('keydown', onKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
}
