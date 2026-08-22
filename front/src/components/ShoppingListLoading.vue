<template>
  <div>
    <!-- The title is already known — it came with the index — so it is shown for real; only
         the rows are being waited for. The back button works throughout: a list that is slow
         to arrive is exactly when leaving again has to be possible. -->
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="$emit('back')" />
      <div v-if="name" class="text-h6 text-weight-bold q-ml-sm ellipsis">{{ name }}</div>
      <q-skeleton v-else type="text" width="140px" class="q-ml-md" />
    </div>

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
  </div>
</template>

<script>
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
const ROW_WIDTHS = ['70%', '45%', '85%', '55%', '60%', '40%', '75%', '50%']

export default {
  name: 'ShoppingListLoading',

  props: {
    // The list's title, if the index already told us. Empty for a list opened by URL alone.
    name: { type: String, default: '' },
    // How many rows the index said this list has, so the placeholder is the height the list
    // is about to be and the arriving rows do not shove the page. Unknown lists get a few.
    rows: { type: Number, default: 3 },
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
