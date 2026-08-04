<template>
  <div class="row items-center q-mb-sm no-wrap">
    <q-btn flat round dense icon="arrow_back" @click="emit('back')" />
    <q-input
      v-model="store.listName"
      dense
      borderless
      class="col q-ml-sm"
      input-class="text-h6 text-weight-bold ellipsis"
      @focus="store.beginNameEdit"
      @change="store.saveName"
      @keydown.enter.prevent="onTitleEnter"
    />
    <q-space />
    <q-btn
      flat
      round
      dense
      icon="check_box"
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
      :color="store.showQuantity ? 'primary' : 'grey'"
      @click="store.toggleQuantity"
    >
      <q-tooltip>{{ store.showQuantity ? 'Hide quantity' : 'Show quantity' }}</q-tooltip>
    </q-btn>
    <q-btn flat round dense icon="undo" :disable="!store.canUndo" @click="store.undo">
      <q-tooltip>Undo</q-tooltip>
    </q-btn>
    <q-btn flat round dense icon="redo" :disable="!store.canRedo" @click="store.redo">
      <q-tooltip>Redo</q-tooltip>
    </q-btn>
  </div>
</template>

<script setup>
import { useShoppingListStore } from 'src/stores/shoppingList'

// Navigation stays with the page — it owns the router and the flush-before-leave.
const emit = defineEmits(['back'])

const store = useShoppingListStore()

// Enter in the title just commits it — blurring fires `change`, which saves.
function onTitleEnter(e) {
  e.target.blur()
}
</script>
