import { nextTick } from 'vue'

/**
 * The page's handle on its row components, addressed by row key.
 *
 * Focus and height re-measurement are DOM concerns, which is why they live here and not
 * in the store: the store hands back the key of a row it just created, and this turns
 * that key into a caret in the right field.
 *
 * Also owns the `resize` listener, because re-measuring after a width change is the same
 * concern as `regrowNames` itself — see the note there.
 *
 * `rowRefs` is set up in `created` rather than declared in `data`: it holds child component
 * instances, and making the map reactive would wrap each of them in a proxy for no reason
 * and deep-watch a structure nothing renders from.
 */
export default {
  created() {
    this.rowRefs = new Map()
  },

  mounted() {
    window.addEventListener('resize', this.regrowNames)
  },

  beforeUnmount() {
    window.removeEventListener('resize', this.regrowNames)
  },

  methods: {
    /** Pass as `:ref` on each row; Vue calls it with null as the row goes away. */
    setRowRef(key, el) {
      if (el) this.rowRefs.set(key, el)
      else this.rowRefs.delete(key)
    },

    // Rows for a key that was just added do not exist until the next render, so every
    // focus call waits a tick. A null key (nothing was added) is a no-op by design.
    // `caret` is passed straight through: a row split off another one wants the cursor at
    // the seam (0), a row created empty does not care.
    focusName(key, caret) {
      if (key) nextTick(() => this.rowRefs.get(key)?.focusName(caret))
    },

    focusQty(key) {
      if (key) nextTick(() => this.rowRefs.get(key)?.focusQty())
    },

    // Quasar's `autogrow` re-measures on input only, so anything that changes a name
    // field's width — a column toggle, a rotation, a wider window — leaves a wrapped name
    // clipped at its old height until it is next typed into.
    regrowNames() {
      nextTick(() => {
        for (const row of this.rowRefs.values()) row?.regrow()
      })
    },
  },
}
