<template>
  <q-item>
    <q-item-section avatar><q-icon name="key" color="grey-7" /></q-item-section>
    <q-item-section>
      <q-item-label>Passkey</q-item-label>
      <q-item-label caption>Added {{ addedOn }}</q-item-label>
    </q-item-section>
    <q-item-section side>
      <q-btn
        flat
        round
        dense
        size="sm"
        icon="delete"
        color="negative"
        :disable="encryption.busy"
        @click="$emit('remove')"
      />
    </q-item-section>
  </q-item>
</template>

<script>
import { useEncryptionStore } from 'src/stores/encryption'

/**
 * One registered passkey.
 *
 * Deliberately has nothing to say about *which* passkey it is: no device name, because the app
 * has none worth quoting — the only thing it could derive one from is the user agent, which says
 * "Chrome on Android" for the installed Play Store build too. The date it was added is the
 * truthful way to tell two apart, and it is the whole label.
 *
 * Removing is the list's business, not this row's — it is the side that knows what removing this
 * one would cost — so the tap goes up as an event.
 */
export default {
  name: 'PasskeyItem',

  props: {
    passkey: { type: Object, required: true },
  },

  emits: ['remove'],

  computed: {
    // Read straight from the store, as the save indicator does: whether a key operation is in
    // flight is not something the list above has any input on.
    encryption() {
      return useEncryptionStore()
    },

    addedOn() {
      return this.passkey.created_at
        ? new Date(this.passkey.created_at).toLocaleDateString()
        : 'this device'
    },
  },
}
</script>
