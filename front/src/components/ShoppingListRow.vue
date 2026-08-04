<template>
  <q-item class="q-pl-none">
    <q-item-section side style="width: 32px; min-width: 32px" class="items-center row-side">
      <q-icon
        name="drag_indicator"
        class="drag-handle"
        color="grey-6"
        :style="searching ? 'opacity:0.3' : ''"
      />
    </q-item-section>
    <q-item-section
      v-if="showCheckbox"
      side
      style="width: 32px; min-width: 32px"
      class="items-center q-pl-none row-side"
    >
      <q-checkbox
        :model-value="item.checked"
        dense
        size="sm"
        tabindex="-1"
        @update:model-value="(v) => emit('toggle-checked', v)"
      />
    </q-item-section>
    <q-item-section>
      <q-input
        ref="nameInput"
        :model-value="item.name"
        dense
        borderless
        autogrow
        :input-class="struck ? 'row-name row-checked' : 'row-name'"
        @update:model-value="(v) => emit('update:name', v)"
        @focus="emit('edit-start')"
        @change="emit('edit-end')"
        @keydown.enter.prevent="emit('name-enter')"
      />
    </q-item-section>
    <q-item-section
      v-if="showQuantity"
      top
      side
      style="width: 56px; min-width: 56px"
      class="col-auto"
    >
      <q-input
        ref="qtyInput"
        :model-value="item.quantity"
        dense
        borderless
        inputmode="numeric"
        :input-class="struck ? 'text-center row-checked' : 'text-center'"
        @update:model-value="onQtyInput"
        @keypress="onQtyKeypress"
        @focus="emit('edit-start')"
        @change="emit('edit-end')"
        @keydown.enter.prevent="emit('qty-enter')"
      />
    </q-item-section>
    <q-item-section side style="width: 20px; min-width: 20px" class="q-pl-none row-side">
      <q-btn
        flat
        round
        dense
        size="sm"
        padding="none"
        tabindex="-1"
        icon="delete"
        color="negative"
        @click="emit('remove')"
      />
    </q-item-section>
  </q-item>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue'

const props = defineProps({
  item: { type: Object, required: true },
  showQuantity: { type: Boolean, default: true },
  showCheckbox: { type: Boolean, default: true },
  // dims the drag handle while a search is filtering the list (reorder is off then)
  searching: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:name',
  'update:quantity',
  'toggle-checked',
  'edit-start',
  'edit-end',
  'name-enter',
  'qty-enter',
  'remove',
])

const nameInput = ref(null)
const qtyInput = ref(null)

// Hiding the checkbox column also drops the strikethrough — otherwise a checked
// row would be struck through with no way to uncheck it. The flag itself is kept.
const struck = computed(() => props.showCheckbox && props.item.checked)

// quantity accepts positive integers only ("" allowed = no quantity)
function onQtyKeypress(e) {
  if (!/[0-9]/.test(e.key)) e.preventDefault()
}
function onQtyInput(value) {
  const digits = String(value ?? '')
    .replace(/[^0-9]/g, '')
    .replace(/^0+/, '')
  emit('update:quantity', digits)
  // force the DOM to reflect the sanitized value even when the model is unchanged
  // (e.g. pasting "abc" collapses to "" which equals the previous model value)
  nextTick(() => {
    const el = qtyInput.value?.nativeEl
    if (el && el.value !== digits) el.value = digits
  })
}

defineExpose({
  focusName: () => nameInput.value?.focus(),
  focusQty: () => qtyInput.value?.focus(),
  // Quasar's `autogrow` re-measures on input only, so anything that changes this
  // column's width (rotation, toggling a column) leaves a wrapped row clipped at
  // its old height. A native input event runs Quasar's own measurement; the value
  // is unchanged, so QInput swallows it without emitting an update.
  regrow: () => nameInput.value?.nativeEl?.dispatchEvent(new Event('input')),
})
</script>

<style scoped>
.drag-handle {
  cursor: grab;
}
.drag-handle:active {
  cursor: grabbing;
}
/* Long names wrap, so a row can be several lines tall. Pin the side controls to
   a one-line-tall box at the top so they stay level with the first line of text
   (40px = height of a dense borderless q-input holding one line). */
.row-side {
  align-self: flex-start;
  height: 40px;
}
/* Justify the wrapped name so every full line reaches both edges, like a book.
   The last line of an item stays flush left, as it does in print. */
:deep(.row-name) {
  text-align: justify;
}
/* :deep — the class lands on the native input inside q-input */
:deep(.row-checked) {
  text-decoration: line-through;
  opacity: 0.55;
}
</style>
