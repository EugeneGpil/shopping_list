<template>
  <div>
    <q-card-section class="row items-center q-gutter-sm">
      <q-icon name="key" size="28px" color="primary" />
      <div class="text-h6">Set up an encryption key</div>
    </q-card-section>

    <q-card-section class="q-pt-none text-body2">
      <p>
        This creates a passkey — your fingerprint, face or screen lock — and a key that never
        leaves your devices. Afterwards you can lock any single list, and its items are encrypted
        here before they are sent. The server stores text it cannot read.
      </p>
      <p>Nothing is locked by setting this up. Your lists stay exactly as they are.</p>
      <p class="text-weight-medium">
        If you lose every passkey you register — and the account they sync through — the locked
        lists are gone. Nobody can recover them, including me.
      </p>
      <!-- `false`, not falsy: `null` is "not asked yet", and warning during that would put this
           in front of every device for as long as the query takes. -->
      <p v-if="encryption.platformAuthenticator === false" class="text-warning">
        This device has no built-in fingerprint or screen-lock authenticator, so you will need a
        security key.
      </p>
    </q-card-section>

    <q-card-section v-if="error" class="q-pt-none text-negative text-body2">
      {{ error }}
    </q-card-section>

    <q-card-actions align="right">
      <q-btn flat no-caps label="Not now" v-close-popup :disable="encryption.busy" />
      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="fingerprint"
        label="Create the key"
        :loading="encryption.busy"
        @click="create"
      />
    </q-card-actions>
  </div>
</template>

<script>
import { useEncryptionStore } from 'src/stores/encryption'

/**
 * Setting the key up, for an account that has none — the first half of §6.
 *
 * **It converts nothing**, which is why this screen can promise that the lists stay as they are:
 * encryption is per list (§1), so all this does is make "encrypt this list" possible. That is what
 * keeps it cheap enough to offer before it is needed, rather than as a decision about the account.
 */
export default {
  name: 'EncryptionKeySetup',

  data() {
    return { error: '' }
  },

  computed: {
    encryption() {
      return useEncryptionStore()
    },
  },

  mounted() {
    // Asked here rather than on boot: it is only ever shown on this screen, and the store keeps
    // the answer so opening the dialog again does not ask the platform twice.
    this.encryption.checkPlatformAuthenticator()
  },

  methods: {
    /**
     * The failure is always shown, the dismissed prompt included: the platform reports "you
     * cancelled" and "no passkey here can do this" identically (see `PasskeyCancelledError`), so
     * staying quiet would turn a real failure into a button that visibly does nothing.
     */
    async create() {
      this.error = ''
      try {
        await this.encryption.createKey()
        this.$q.notify({
          type: 'positive',
          message: 'Key created. Open a list and press the lock to encrypt it.',
        })
      } catch (err) {
        this.error = err.message ?? 'Could not create the key.'
      }
    },
  },
}
</script>
