<template>
  <!-- Fixed rather than in the page flow, so it takes up no space and can never shift the
       list — which is also why `v-if` is safe here. -->
  <div
    v-if="store.saveStatus"
    class="save-status text-caption"
    :class="store.saveFailed ? 'save-status--failed' : 'text-grey'"
  >
    {{ store.saveStatus }}
  </div>
</template>

<script setup>
import { useShoppingListsStore } from 'src/stores/shoppingLists'

// Read straight from the store, as the header does: the status has no input from the page.
const store = useShoppingListsStore()
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
   itself, so give it weight and a tinted background rather than colour alone. The red is
   set here rather than with `text-negative`, because that utility is `!important` and
   there would be no overriding it for dark below. */
.save-status--failed {
  font-weight: 500;
  color: var(--q-negative);
  background: #fdecee;
  box-shadow: 0 1px 4px rgba(193, 0, 21, 0.28);
}
/* The colours above are the only ones in the app stated rather than taken from the theme:
   this pill has its own backdrop, so it has to follow the page under it. Quasar puts
   `body--dark` on for us; everything else here is a theme colour and needs no counterpart. */
.body--dark .save-status {
  background: rgba(48, 48, 48, 0.94);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.5);
}
/* The theme's negative is a red picked to sit on white; on a dark chip it reads as almost
   black, so the dark side takes the lighter red that job gets on dark surfaces. */
.body--dark .save-status--failed {
  color: #ff8a80;
  background: #3d1c20;
  box-shadow: 0 1px 4px rgba(255, 82, 82, 0.24);
}
</style>
