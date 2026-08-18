<template>
  <!-- `q-pr-sm` halves Quasar's 16px right padding: the row actions are the last thing in
       the row, and a wide gutter behind them is width the name could have had. -->
  <q-item class="q-pl-none q-pr-sm">
    <q-item-section side style="width: 32px; min-width: 32px" class="items-center row-side">
      <q-icon
        name="drag_indicator"
        class="drag-handle"
        color="grey-6"
        :style="searching ? 'opacity:0.3' : ''"
      />
    </q-item-section>
    <q-item-section
      v-if="store.showCheckbox"
      side
      style="width: 32px; min-width: 32px"
      class="items-center q-pl-none row-side"
    >
      <q-checkbox
        :model-value="item.checked"
        dense
        size="sm"
        tabindex="-1"
        @update:model-value="(v) => store.toggleChecked(index, v)"
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
        @update:model-value="(v) => store.setName(index, v)"
        @focus="store.beginEdit"
        @change="store.endEdit"
        @keydown.enter.prevent="onNameEnter"
        @keydown.backspace="onNameBackspace"
      />
    </q-item-section>
    <q-item-section
      v-if="store.showQuantity"
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
        @focus="store.beginEdit"
        @change="store.endEdit"
        @keydown.enter.prevent="$emit('qty-enter')"
      />
    </q-item-section>
    <q-item-section side class="row-delete">
      <q-btn
        flat
        round
        dense
        size="sm"
        padding="none"
        tabindex="-1"
        icon="delete"
        color="negative"
        @click="store.removeRow(index)"
      />
    </q-item-section>
  </q-item>
</template>

<script>
import { nextTick } from 'vue'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

export default {
  name: 'ShoppingListRow',

  props: {
    // Where this row sits in `store.items`. It reads its data from there and names the
    // same position back in every action it calls, so the index is all the page has to
    // hand over.
    //
    // Bound from vuedraggable's slot index, which is what makes it survive a reorder: the
    // component is keyed by `_key` so the instance follows its row, and a row that moved
    // gets the new index that resolves back to the same item.
    index: { type: Number, required: true },
    // Page state rather than list data, so it stays a prop: dims the drag handle while a
    // search is filtering the list, because reordering is disabled then.
    searching: { type: Boolean, default: false },
  },

  // Only Enter is the page's business — it moves focus to another row, or adds one and
  // focuses that, and focus across rows is the page's job. Everything else this row does
  // is a store call it can make itself.
  //
  // `name-enter` carries the field's selection, because where the caret sat is the one
  // thing the page cannot look up: with the quantity column hidden, Enter splits the name
  // there. `name-backspace` is the other half of that — it only fires from the one spot
  // where Backspace means something to the list rather than to the text.
  emits: ['name-enter', 'qty-enter', 'name-backspace'],

  computed: {
    store() {
      return useShoppingListsStore()
    },

    // Read straight from the store, as the header and the save indicator do. Writes go back
    // through actions — this row holds no copy of its data.
    item() {
      return this.store.items[this.index]
    },

    // Hiding the checkbox column also drops the strikethrough — otherwise a checked
    // row would be struck through with no way to uncheck it. The flag itself is kept.
    struck() {
      return this.store.showCheckbox && this.item.checked
    },
  },

  methods: {
    // Read off the event target rather than the ref: this is the very textarea the key was
    // pressed in, and its selection is still where the user left it.
    onNameEnter(e) {
      const el = e.target
      this.$emit('name-enter', el.selectionStart, el.selectionEnd)
    },

    // Backspace with the caret at the very start and nothing selected is the one case where
    // the key is about the list rather than the text: there is no character in front of it to
    // delete, so it joins this row to the one above instead. Every other Backspace — a
    // selection, a caret further in — is an ordinary delete and stays with the field.
    onNameBackspace(e) {
      const el = e.target
      if (el.selectionStart !== 0 || el.selectionEnd !== 0) return
      e.preventDefault()
      this.$emit('name-backspace')
    },

    // Reject non-digits at the keystroke, so the caret never jumps; the store sanitizes
    // whatever still gets in (a paste, an IME) and hands back what it stored.
    onQtyKeypress(e) {
      if (!/[0-9]/.test(e.key)) e.preventDefault()
    },

    onQtyInput(value) {
      const digits = this.store.setQuantity(this.index, value)
      // force the DOM to reflect the sanitized value even when the model is unchanged
      // (e.g. pasting "abc" collapses to "" which equals the previous model value)
      nextTick(() => {
        const el = this.$refs.qtyInput?.nativeEl
        if (el && el.value !== digits) el.value = digits
      })
    },

    // ---- what the page calls through its row refs ----
    //
    // Public by virtue of being methods, which is what `defineExpose` had to say by hand.

    // `caret` places the cursor inside the text instead of wherever the browser would put
    // it: a row that was just split off carries the tail of another one, and the user is
    // mid-word — they should be typing at the seam, not at the end of what moved down.
    focusName(caret) {
      this.$refs.nameInput?.focus()
      if (caret != null) this.$refs.nameInput?.nativeEl?.setSelectionRange(caret, caret)
    },

    focusQty() {
      this.$refs.qtyInput?.focus()
    },

    // Quasar's `autogrow` re-measures on input only, so anything that changes this
    // column's width (rotation, toggling a column) leaves a wrapped row clipped at
    // its old height. A native input event runs Quasar's own measurement; the value
    // is unchanged, so QInput swallows it without emitting an update.
    regrow() {
      this.$refs.nameInput?.nativeEl?.dispatchEvent(new Event('input'))
    },
  },
}
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
/* The delete button, level with the first line of the name like every other side control.
   No width of its own — the button is the whole column. `padding-left` is Quasar's own:
   it indents a section after the main one by 16px, which here would only push the name
   over for empty space. */
.row-delete {
  align-self: flex-start;
  height: 40px;
  flex-shrink: 0;
  padding-left: 0;
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
