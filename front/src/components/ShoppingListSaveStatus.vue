<template>
  <!-- Fixed rather than in the page flow, so it takes up no space and can never shift the
       list — which is also why `v-if` is safe here. -->
  <div
    v-if="store.saveStatus"
    class="save-status text-caption"
    :class="store.saveFailed ? 'save-status--failed text-negative' : 'text-grey'"
  >
    {{ store.saveStatus }}
  </div>
</template>

<script setup>
import { useShoppingListStore } from 'src/stores/shoppingList'

// Read straight from the store, as the header does: the status has no input from the page.
const store = useShoppingListStore()
</script>

<style scoped>
/* Out of the flow entirely: transient feedback should never move the list under the
   user's finger. The backdrop keeps it legible when it lands over a row. */
.save-status {
  position: fixed;
  right: 12px;
  bottom: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.92);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
  pointer-events: none;
}
/* A failure is the one state worth interrupting for: unlike "Saved" it does not clear
   itself, so give it weight and a tinted background rather than colour alone. */
.save-status--failed {
  font-weight: 500;
  background: #fdecee;
  box-shadow: 0 1px 4px rgba(193, 0, 21, 0.28);
}
</style>
