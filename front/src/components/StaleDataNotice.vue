<template>
  <!-- What is on screen is real data, just not confirmed with the server since the last
       time we could reach it. Saying so is the difference between a list that is trusted
       and one that quietly disagrees with the one in someone else's hand. -->
  <div v-if="store.stale" class="row items-center q-gutter-xs q-mb-sm text-grey">
    <q-icon name="cloud_off" size="16px" />
    <span class="text-caption">Not connected — showing the copy saved on this device</span>
  </div>
</template>

<script>
import { useShoppingListsStore } from 'src/stores/shoppingLists'

export default {
  name: 'StaleDataNotice',

  computed: {
    // Reads the store directly, as the save indicator does: nothing about this is a page's
    // business, and both pages want the same line in the same words.
    store() {
      return useShoppingListsStore()
    },
  },
}
</script>
