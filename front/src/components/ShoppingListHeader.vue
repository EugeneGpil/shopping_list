<template>
  <div class="row items-start q-mb-sm">
    <!-- Title and toolbar are separate flex groups so that when the title no longer has
         room to wrap readably, the toolbar drops to its own line and the title gets the
         full width — rather than being squeezed into a sliver with empty space beside it. -->
    <div class="row items-start no-wrap title-group">
      <q-btn flat round dense icon="arrow_back" class="header-btn" @click="emit('back')" />
      <q-input
        ref="titleInput"
        v-model="store.listName"
        dense
        borderless
        autogrow
        class="col q-ml-sm"
        input-class="text-h6 text-weight-bold"
        @focus="store.beginNameEdit"
        @change="store.saveName"
        @keydown.enter.prevent="onTitleEnter"
      />
    </div>
    <div class="row items-start no-wrap">
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

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useShoppingListStore } from 'src/stores/shoppingList'

// Navigation stays with the page — it owns the router and the flush-before-leave.
const emit = defineEmits(['back'])

const store = useShoppingListStore()

const titleInput = ref(null)

// Enter in the title just commits it — blurring fires `change`, which saves.
// It never inserts a newline, even though `autogrow` makes this a textarea.
function onTitleEnter(e) {
  e.target.blur()
}

// Same caveat as the item rows: Quasar's `autogrow` re-measures on input only, so a
// width change (rotation, a wider window) leaves a wrapped title clipped at its old
// height. A native input event runs Quasar's measurement without emitting an update.
function regrowTitle() {
  nextTick(() => {
    titleInput.value?.nativeEl?.dispatchEvent(new Event('input'))
  })
}

onMounted(() => window.addEventListener('resize', regrowTitle))
onBeforeUnmount(() => window.removeEventListener('resize', regrowTitle))
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
