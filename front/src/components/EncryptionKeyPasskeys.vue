<template>
  <div>
    <q-card-section class="row items-center q-gutter-sm">
      <q-icon name="key" size="28px" color="positive" />
      <div class="text-h6">Encryption key</div>
    </q-card-section>

    <q-card-section class="q-pt-none text-body2 text-grey-7">
      Any of these passkeys opens your locked lists. Lock a list from inside it, with the lock
      button next to its title.
    </q-card-section>

    <q-card-section class="q-pt-none">
      <q-list dense separator>
        <PasskeyItem
          v-for="key in encryption.keys"
          :key="key.credential_id"
          :passkey="key"
          @remove="remove(key)"
        />
      </q-list>
    </q-card-section>

    <q-card-section v-if="error" class="q-pt-none text-negative text-body2">
      {{ error }}
    </q-card-section>

    <q-card-actions align="right">
      <q-btn flat no-caps label="Close" v-close-popup :disable="encryption.busy" />
      <q-btn
        unelevated
        no-caps
        color="primary"
        icon="add"
        label="Add a passkey"
        :loading="encryption.busy"
        @click="addPasskey"
      />
    </q-card-actions>
  </div>
</template>

<script>
import PasskeyItem from 'src/components/PasskeyItem.vue'
import { useEncryptionStore } from 'src/stores/encryption'

/**
 * The passkeys that can open the key, for an account that has one — the second half of §6.
 *
 * Adding one is the entire recovery story (§1) and the only way to read these lists on a device
 * the first passkey does not sync to. Removing the key altogether is deliberately absent: with
 * per-list encryption the way out is to unlock the locked lists one at a time, and the server
 * refuses the last remaining passkey precisely so that stays possible.
 */
export default {
  name: 'EncryptionKeyPasskeys',

  components: { PasskeyItem },

  data() {
    return { error: '' }
  },

  computed: {
    encryption() {
      return useEncryptionStore()
    },
  },

  methods: {
    /** Unlocking first, when needed, is the store's job — see `addPasskey` there. */
    async addPasskey() {
      this.error = ''
      try {
        await this.encryption.addPasskey()
        this.$q.notify({ type: 'positive', message: 'Passkey added.' })
      } catch (err) {
        // Shown rather than swallowed, the dismissed prompt included — see `create` in
        // `EncryptionKeySetup`.
        this.error = err.message ?? 'Could not add that passkey.'
      }
    },

    /**
     * What removing this passkey actually costs, which is three different things.
     *
     * Worth the branch: the button is reachable in all three situations, and one sentence covering
     * them all ends up describing locked lists to someone who has none — true of nothing, and
     * alarming for no reason.
     */
    removalWarning(lockedCount) {
      if (this.encryption.keys.length < 2) {
        return (
          'This is the only passkey, so removing it leaves the account with no encryption key. ' +
          'Nothing is locked, so nothing becomes unreadable — but setting encryption up again ' +
          'later creates a different key.'
        )
      }
      if (lockedCount) {
        return (
          `This passkey will no longer open your ${lockedCount} locked list(s). Your other ` +
          'passkeys still will, and the lists themselves are untouched.'
        )
      }

      return 'This passkey will no longer be usable for lists you lock later. Your other passkeys will.'
    },

    remove(key) {
      const lockedCount = this.encryption.lockedListCount()

      // Answered on the tap rather than by grey-ing the button out: a disabled control explains
      // nothing, and this is the one refusal in the app that a user is entitled to a reason for.
      if (this.encryption.isLastWayIn()) {
        this.$q.dialog({
          title: 'This passkey cannot be removed',
          message:
            `It is the only one that can open your ${lockedCount} locked list(s), and ` +
            'removing it would leave them unopenable for good. Add a second passkey, or unlock ' +
            'those lists first.',
          ok: { label: 'OK', flat: true, noCaps: true },
        })

        return
      }

      this.$q.dialog({
        title: 'Remove passkey',
        message: this.removalWarning(lockedCount),
        cancel: true,
        ok: { label: 'Remove', color: 'negative' },
      }).onOk(async () => {
        this.error = ''
        try {
          await this.encryption.removePasskey(key.credential_id)
        } catch (err) {
          // 409 is the server refusing to leave this account with no way in at all.
          this.error = err.body?.message ?? 'Could not remove that passkey.'
        }
      })
    },
  },
}
</script>
