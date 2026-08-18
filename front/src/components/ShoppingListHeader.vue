<template>
  <div class="row items-start q-mb-sm">
    <!-- Title and toolbar are separate flex groups so that when the title no longer has
         room to wrap readably, the toolbar drops to its own line and the title gets the
         full width — rather than being squeezed into a sliver with empty space beside it. -->
    <div class="row items-start no-wrap title-group">
      <q-btn flat round dense icon="arrow_back" class="header-btn" @click="$emit('back')" />
      <q-input
        ref="titleInput"
        :model-value="store.listName"
        dense
        borderless
        autogrow
        class="col q-ml-sm"
        input-class="text-h6 text-weight-bold"
        @update:model-value="store.setListName"
        @focus="store.beginNameEdit"
        @change="store.saveName"
        @keydown.enter.prevent="onTitleEnter"
      />
    </div>
    <div class="row items-start no-wrap">
      <!-- The search field is folded away behind this until it is wanted: a list is read
           far more often than it is searched, and the box was taking a row of screen from
           the list on every visit. Lit like the column toggles while it is open. -->
      <q-btn
        flat
        round
        dense
        icon="search"
        class="header-btn"
        :color="searching ? 'primary' : 'grey'"
        @click="$emit('toggle-search')"
      >
        <q-tooltip>{{ searching ? 'Close search' : 'Search' }}</q-tooltip>
      </q-btn>
      <q-btn
        flat
        round
        dense
        icon="check_box"
        class="header-btn"
        :color="store.showCheckbox ? 'primary' : 'grey'"
        @click="store.toggleCheckbox"
      >
        <q-tooltip>{{ store.showCheckbox ? 'Hide checkboxes' : 'Show checkboxes' }}</q-tooltip>
      </q-btn>
      <q-btn
        flat
        round
        dense
        icon="pin"
        class="header-btn"
        :color="store.showQuantity ? 'primary' : 'grey'"
        @click="store.toggleQuantity"
      >
        <q-tooltip>{{ store.showQuantity ? 'Hide quantity' : 'Show quantity' }}</q-tooltip>
      </q-btn>
      <!-- Encryption, as a per-list switch rather than an account-wide mode (§1). Lit when
           this list is locked, and it is the only place the choice is made. -->
      <q-btn
        flat
        round
        dense
        :icon="encrypted ? 'lock' : 'lock_open'"
        class="header-btn"
        :color="encrypted ? 'primary' : 'grey'"
        :loading="lockBusy"
        @click="$emit('toggle-lock')"
      >
        <q-tooltip>{{ encrypted ? 'Stop encrypting this list' : 'Encrypt this list' }}</q-tooltip>
      </q-btn>
      <q-btn
        flat
        round
        dense
        icon="undo"
        class="header-btn"
        :disable="!store.canUndo"
        @click="store.undo"
      >
        <q-tooltip>Undo</q-tooltip>
      </q-btn>
      <q-btn
        flat
        round
        dense
        icon="redo"
        class="header-btn"
        :disable="!store.canRedo"
        @click="store.redo"
      >
        <q-tooltip>Redo</q-tooltip>
      </q-btn>
    </div>
  </div>
</template>

<script>
import { nextTick } from 'vue'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

export default {
  name: 'ShoppingListHeader',

  props: {
    // Whether the page currently has the search field open. Only lights the button — the
    // field, the text in it and the filtering all belong to the page.
    searching: { type: Boolean, default: false },
    // Whether this list is encrypted, and whether that is being changed right now. Passed in
    // rather than read from the store: the page owns the flow behind it, which can involve a
    // fingerprint prompt and a key that does not exist yet.
    encrypted: { type: Boolean, default: false },
    lockBusy: { type: Boolean, default: false },
  },

  // Navigation stays with the page — it owns the router and the flush-before-leave — and so
  // do the search field and the lock, so all three of these are the page's to act on.
  emits: ['back', 'toggle-search', 'toggle-lock'],

  computed: {
    store() {
      return useShoppingListsStore()
    },
  },

  mounted() {
    window.addEventListener('resize', this.regrowTitle)
  },

  beforeUnmount() {
    window.removeEventListener('resize', this.regrowTitle)
  },

  methods: {
    // Enter in the title just commits it — blurring fires `change`, which saves.
    // It never inserts a newline, even though `autogrow` makes this a textarea.
    onTitleEnter(e) {
      e.target.blur()
    },

    // Same caveat as the item rows: Quasar's `autogrow` re-measures on input only, so a
    // width change (rotation, a wider window) leaves a wrapped title clipped at its old
    // height. A native input event runs Quasar's measurement without emitting an update.
    regrowTitle() {
      nextTick(() => {
        this.$refs.titleInput?.nativeEl?.dispatchEvent(new Event('input'))
      })
    },
  },
}
</script>

<style scoped>
/* Grow to fill the row, but never squeeze below a width the title can still wrap
   readably in — under that, the toolbar wraps to the next line instead. */
.title-group {
  flex: 1 1 200px;
  min-width: 0;
}
/* The title wraps, so this row can be several lines tall. Keep the buttons level with
   the first line instead of drifting to the middle of a tall title. */
.header-btn {
  align-self: flex-start;
  margin-top: 2px;
}
</style>
