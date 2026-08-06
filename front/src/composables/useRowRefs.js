import { nextTick, onMounted, onBeforeUnmount } from 'vue'

/**
 * The page's handle on its row components, addressed by row key.
 *
 * Focus and height re-measurement are DOM concerns, which is why they live here and not
 * in the store: the store hands back the key of a row it just created, and this turns
 * that key into a caret in the right field.
 *
 * Also owns the `resize` listener, because re-measuring after a width change is the same
 * concern as `regrowNames` itself — see the note there.
 */
export function useRowRefs() {
  const rowRefs = new Map()

  /** Pass as `:ref` on each row; Vue calls it with null as the row goes away. */
  function setRowRef(key, el) {
    if (el) rowRefs.set(key, el)
    else rowRefs.delete(key)
  }

  // Rows for a key that was just added do not exist until the next render, so every
  // focus call waits a tick. A null key (nothing was added) is a no-op by design.
  function focusName(key) {
    if (key) nextTick(() => rowRefs.get(key)?.focusName())
  }

  function focusQty(key) {
    if (key) nextTick(() => rowRefs.get(key)?.focusQty())
  }

  // Quasar's `autogrow` re-measures on input only, so anything that changes a name
  // field's width — a column toggle, a rotation, a wider window — leaves a wrapped name
  // clipped at its old height until it is next typed into.
  function regrowNames() {
    nextTick(() => {
      for (const row of rowRefs.values()) row?.regrow()
    })
  }

  onMounted(() => window.addEventListener('resize', regrowNames))
  onBeforeUnmount(() => window.removeEventListener('resize', regrowNames))

  return { setRowRef, focusName, focusQty, regrowNames }
}
