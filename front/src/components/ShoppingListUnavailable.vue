<template>
  <div>
    <!-- A back button and nothing else: the real header edits the list name and the column
         toggles, and none of that exists yet when the list never arrived. -->
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="emit('back')" />
    </div>

    <div class="text-center q-my-xl">
      <q-icon name="cloud_off" size="48px" color="grey-6" />
      <div class="text-subtitle1 q-mt-sm">Can't reach the server</div>
      <div class="text-grey q-mt-xs">This list will open as soon as you are back online.</div>
      <q-btn
        outline
        no-caps
        color="primary"
        label="Retry"
        class="q-mt-md"
        :loading="retrying"
        @click="emit('retry')"
      />
    </div>
  </div>
</template>

<script setup>
// Shown in place of the editor when the list could not be fetched *and the server never
// answered* — offline, or the backend unreachable. A server that did answer ("no such
// list", "not yours") is final and the page navigates away instead of rendering this.
defineProps({
  // Keeps the button spinning while a retry is in flight, and blocks a second one.
  retrying: Boolean,
})

// Both actions belong to the page: it owns the router and the load.
const emit = defineEmits(['back', 'retry'])
</script>
