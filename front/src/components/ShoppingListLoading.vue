<template>
  <div>
    <!-- The title is already known — it came with the index — so it is shown for real; only
         the rows are being waited for. The back button works throughout: a list that is slow
         to arrive is exactly when leaving again has to be possible. -->
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="$emit('back')" />
      <!-- `col` and not just `ellipsis`: without a flex basis a long title is wider than
           the row and gets wrapped onto its own line below the back button, which is what
           a 603-character one did. Same treatment as the real title in
           `ShoppingListHeader`, so the placeholder breaks where the editor does. -->
      <div v-if="name" class="col text-h6 text-weight-bold q-ml-sm ellipsis">{{ name }}</div>
      <q-skeleton v-else type="text" width="140px" class="q-ml-md" />
    </div>

    <div class="loading-rows">
      <div class="q-list q-list--bordered q-list--separator rounded-borders">
        <q-item v-for="(width, i) in widths" :key="i">
          <q-item-section side style="width: 32px; min-width: 32px" class="items-center">
            <q-skeleton type="QAvatar" size="18px" />
          </q-item-section>
          <q-item-section>
            <q-skeleton type="text" :width="width" />
          </q-item-section>
        </q-item>
      </div>

      <!-- The bars alone were not enough: a column of grey placeholders is still read as a
           list, just an odd-looking one, and the whole point of this screen is that it is not
           a list yet. The spinner is the part that cannot be mistaken for content — it moves,
           and nothing in a loaded list ever does. -->
      <div class="loading-spinner">
        <div class="loading-disc">
          <q-spinner color="primary" size="36px" :thickness="4" />
        </div>
      </div>
    </div>
  </div>
</template>

<script>
const ROW_WIDTHS = ['70%', '45%', '85%', '55%', '60%', '40%', '75%', '50%']

/**
 * Shown in place of the editor while a list that is not cached is being fetched.
 *
 * Without it the editor rendered empty for as long as the request took — a list with a
 * title, an "Add item" button and "No items yet." under it, none of it true and none of it
 * usable: `markLoaded()` had not run, so a row added there would have been dropped. Same
 * reasoning as `ShoppingListUnavailable` and `ShoppingListLocked`, and the third of the
 * three states that replace the editor rather than showing it half-alive.
 *
 * Only the *first* open of a list ever gets here. After that its items are cached and the
 * editor renders on the first frame, with `_revalidate` catching up behind it.
 */
export default {
  name: 'ShoppingListLoading',

  props: {
    // The list's title, if the index already told us. Empty for a list opened by URL alone.
    name: { type: String, default: '' },
    // How many rows the index said this list has, so the placeholder is the height the list
    // is about to be and the arriving rows do not shove the page. Zero means the index has
    // not said — the fallback for that lives in `widths()`, so the figure is written once.
    rows: { type: Number, default: 0 },
  },

  emits: ['back'],

  computed: {
    // Ragged on purpose — a column of identical bars reads as a loaded table of blanks.
    widths() {
      const count = Math.min(Math.max(this.rows || 3, 1), 12)
      return Array.from({ length: count }, (_, i) => ROW_WIDTHS[i % ROW_WIDTHS.length])
    },
  },
}
</script>

<style scoped>
/* Quasar's skeleton grey is rgba(0, 0, 0, 0.12) on a light page and rgba(255, 255, 255,
   0.05) on a dark one. The dark figure is what made this screen read as an *empty* list:
   at 5% white on #121212 the bars are all but invisible, so what was left on screen was a
   title, a bordered box and nothing in it.

   The app follows the OS (`framework.config.dark: 'auto'`), so neither side is theoretical
   — and Quasar picks the dark variant itself, which is why this has to win on specificity
   rather than just declare a colour. */
.loading-rows :deep(.q-skeleton) {
  background: rgba(0, 0, 0, 0.2);
}
.body--dark .loading-rows :deep(.q-skeleton) {
  background: rgba(255, 255, 255, 0.22);
}

.loading-rows {
  position: relative;
}

/* `rows` goes up to twelve, and centring in the full height of a twelve-row placeholder
   would put the spinner below the fold on a phone — a spinner nobody sees is the bug this
   is fixing. Nothing underneath is interactive, and the back button is outside this box, so
   the overlay never has to take a tap. */
.loading-spinner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: min(100%, 45vh);
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  /* Quasar's wave animation stacks every skeleton at `z-index: 1`, so an overlay without one
     of its own loses to the bars and they paint straight through the disc. */
  z-index: 2;
}

/* The spinner sits on an opaque disc so it is not read as one more placeholder bar — page
   colour on a light page, a lifted grey on a dark one, where page colour would vanish into the
   gaps between the bars and leave the spinner reading as holes in them. A backdrop rather than
   a theme colour, hence stated per theme like the save-status pill. */
.loading-disc {
  display: flex;
  padding: 12px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
}
.body--dark .loading-disc {
  background: rgba(48, 48, 48, 0.94);
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.5);
}
</style>
