<template>
  <q-dialog v-model="open">
    <q-card style="max-width: 460px">
      <!-- The two states this dialog has, and they never overlap: this account has an encryption
           key or it does not. Each half owns its flow, its error line and its buttons, so there is
           no state here to reset — QDialog unmounts its content on close, which is what stops a
           failed attempt still being on screen the next time it is opened. -->
      <EncryptionKeySetup v-if="!encryption.enabled" />
      <EncryptionKeyPasskeys v-else />
    </q-card>
  </q-dialog>
</template>

<script>
import EncryptionKeyPasskeys from 'src/components/EncryptionKeyPasskeys.vue'
import EncryptionKeySetup from 'src/components/EncryptionKeySetup.vue'
import { useEncryptionStore } from 'src/stores/encryption'

/**
 * The key and its passkeys (§6) — reached from the ⋮ menu on the index.
 *
 * Nothing but the shell: which of the two halves to show, and the `v-model` that opens it. It
 * manages the key and nothing else — which lists are encrypted is decided one list at a time, in
 * the list itself, so there is no "encrypt everything" button here and no progress to report.
 */
export default {
  name: 'EncryptionDialog',

  components: { EncryptionKeyPasskeys, EncryptionKeySetup },

  props: { modelValue: Boolean },

  emits: ['update:modelValue'],

  computed: {
    encryption() {
      return useEncryptionStore()
    },

    open: {
      get() {
        return this.modelValue
      },
      set(value) {
        this.$emit('update:modelValue', value)
      },
    },
  },
}
</script>
