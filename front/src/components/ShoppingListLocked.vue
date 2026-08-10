<template>
  <div>
    <!-- A back button and nothing else, as in `ShoppingListUnavailable`: the real header
         edits a name and toggles columns, none of which can be done from here. -->
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="emit('back')" />
    </div>

    <div class="text-center q-my-xl">
      <q-icon name="lock" size="48px" color="primary" />
      <div class="text-subtitle1 q-mt-sm">This list is encrypted</div>
      <div class="text-grey q-mt-xs">
        Unlock it with your passkey — your fingerprint, face or screen lock. It happens on this
        device; nothing is sent anywhere.
      </div>
      <div v-if="error" class="text-negative q-mt-sm text-body2">{{ error }}</div>
      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="fingerprint"
        label="Unlock"
        class="q-mt-md"
        :loading="unlocking"
        @click="emit('unlock')"
      />
    </div>
  </div>
</template>

<script setup>
/**
 * Shown in place of the editor when the list is encrypted and this session has no key.
 *
 * The whole of the unlock UI, and it lives here rather than in the layout on purpose: with
 * encryption decided per list (§1), a prompt at launch would be asking for a fingerprint on
 * behalf of a list nobody has opened. Everything else in the app — the index, every other
 * list, syncing — carries on without it.
 */
defineProps({
  // Keeps the button spinning while the platform prompt is up, and blocks a second one.
  unlocking: Boolean,
  // Why the last attempt did not work. A dismissed prompt is not one of these.
  error: { type: String, default: '' },
})

const emit = defineEmits(['back', 'unlock'])
</script>
