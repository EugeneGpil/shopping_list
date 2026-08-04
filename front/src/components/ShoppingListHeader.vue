<template>
  <div class="row items-center q-mb-sm no-wrap">
    <q-btn flat round dense icon="arrow_back" @click="emit('back')" />
    <q-input
      :model-value="name"
      dense
      borderless
      class="col q-ml-sm"
      input-class="text-h6 text-weight-bold ellipsis"
      @update:model-value="(v) => emit('update:name', v)"
      @focus="emit('name-focus')"
      @change="emit('name-change')"
      @keydown.enter.prevent="onTitleEnter"
    />
    <q-space />
    <q-btn
      flat
      round
      dense
      icon="check_box"
      :color="showCheckbox ? 'primary' : 'grey'"
      @click="emit('toggle-checkbox')"
    >
      <q-tooltip>{{ showCheckbox ? 'Hide checkboxes' : 'Show checkboxes' }}</q-tooltip>
    </q-btn>
    <q-btn
      flat
      round
      dense
      icon="pin"
      :color="showQuantity ? 'primary' : 'grey'"
      @click="emit('toggle-quantity')"
    >
      <q-tooltip>{{ showQuantity ? 'Hide quantity' : 'Show quantity' }}</q-tooltip>
    </q-btn>
    <q-btn flat round dense icon="undo" :disable="!canUndo" @click="emit('undo')">
      <q-tooltip>Undo</q-tooltip>
    </q-btn>
    <q-btn flat round dense icon="redo" :disable="!canRedo" @click="emit('redo')">
      <q-tooltip>Redo</q-tooltip>
    </q-btn>
  </div>
</template>

<script setup>
defineProps({
  name: { type: String, default: '' },
  showQuantity: { type: Boolean, default: true },
  showCheckbox: { type: Boolean, default: true },
  canUndo: { type: Boolean, default: false },
  canRedo: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:name',
  'name-focus',
  'name-change',
  'back',
  'toggle-quantity',
  'toggle-checkbox',
  'undo',
  'redo',
])

// Enter in the title just commits it — blurring fires `change`, which saves.
function onTitleEnter(e) {
  e.target.blur()
}
</script>
