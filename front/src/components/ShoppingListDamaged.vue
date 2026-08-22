<template>
  <div>
    <!-- A back button and nothing else, as in its two siblings: there is no list here to
         rename and no columns to toggle. -->
    <div class="row items-center q-mb-md">
      <q-btn flat round dense icon="arrow_back" @click="$emit('back')" />
    </div>

    <div class="text-center q-my-xl">
      <q-icon name="lock_open" size="48px" color="warning" />
      <div class="text-subtitle1 q-mt-sm">This list could not be decrypted</div>
      <div class="text-grey q-mt-xs">
        Your key opened, but the contents of this list did not: either the copy on the server is
        damaged, or it was locked with a different key. Nothing has been changed or deleted, and
        your other lists are fine.
      </div>
      <q-btn
        outline
        no-caps
        color="primary"
        :label="backLabel"
        class="q-mt-md"
        @click="$emit('back')"
      />
    </div>
  </div>
</template>

<script>
/**
 * Shown in place of the editor when the rows are ciphertext, the key is here, and the bytes
 * still will not open — `DecryptionFailedError`.
 *
 * Deliberately not `ShoppingListUnavailable`: that offers a retry, and a second copy of the
 * same bytes fails at the same authentication tag. And deliberately not `ShoppingListLocked`:
 * the fingerprint already worked, so there is nothing left to prompt for. And deliberately not
 * a redirect, which is what this replaced — a list that vanished with the route rewritten to
 * `/` and nothing said is indistinguishable from the app losing it.
 *
 * The wording refuses to choose between the two causes because the crypto cannot: GCM rejects
 * a flipped bit and a wrong key with the same tag failure (see `DecryptionFailedError`).
 */
export default {
  name: 'ShoppingListDamaged',

  props: {
    // The page owns the router, so it also owns where "back" goes and what to call it.
    backLabel: { type: String, default: 'Back to lists' },
  },

  emits: ['back'],
}
</script>
