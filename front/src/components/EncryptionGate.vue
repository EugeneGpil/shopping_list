<template>
  <!-- Persistent by design: with encrypted lists and no key there is nothing behind this
       dialog to interact with, and a dismissable one would leave the app looking broken. -->
  <q-dialog v-model="showing" persistent>
    <q-card style="max-width: 420px">
      <q-card-section class="row items-center q-gutter-sm">
        <q-icon name="lock" size="28px" color="primary" />
        <div class="text-h6">Your lists are encrypted</div>
      </q-card-section>

      <q-card-section class="q-pt-none text-body2">
        Unlock them with the passkey you set up — your fingerprint, face or screen lock. This
        happens on this device; nothing is sent anywhere.
      </q-card-section>

      <q-card-section v-if="error" class="q-pt-none text-negative text-body2">
        {{ error }}
      </q-card-section>

      <q-card-actions align="right">
        <q-btn
          unelevated
          color="primary"
          icon="fingerprint"
          label="Unlock"
          :loading="encryption.busy"
          @click="unlock"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useEncryptionStore } from 'src/stores/encryption'

/**
 * The unlock screen (§6). Mounted once, in the layout, because it applies to whichever page
 * the app happens to open on — including a deep link straight into a list.
 *
 * The cached lists behind it are plaintext (§7), so this is not hiding them from anyone
 * holding the phone; it is there because everything arriving from the server is ciphertext
 * until the key is back.
 */

const encryption = useEncryptionStore()

const error = ref('')

// `ready` keeps this from flashing up before the answer is known: the cache says "encrypted"
// instantly on a device that has been set up, but a first-run device has to ask the server.
const showing = computed({
  get: () => encryption.ready && encryption.locked,
  // Only the store closes this, by acquiring the key. The setter exists because `v-model` on
  // a dialog writes back when it closes itself, which `persistent` should never let happen.
  set: () => {},
})

async function unlock() {
  error.value = ''
  try {
    // Refetching what was unreadable is part of unlocking, and lives in the store with it —
    // this dialog is not the only way in, and the order matters (see `unlock`).
    await encryption.unlock()
  } catch (err) {
    // A dismissed prompt is not a failure — there is nothing to explain and the dialog is
    // still there to try again.
    if (err.name !== 'PasskeyCancelledError') error.value = err.message ?? 'Could not unlock.'
  }
}
</script>
