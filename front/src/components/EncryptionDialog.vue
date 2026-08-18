<template>
  <q-dialog v-model="open" @hide="error = ''">
    <q-card style="max-width: 460px">
      <!-- No key yet -->
      <template v-if="!encryption.enabled">
        <q-card-section class="row items-center q-gutter-sm">
          <q-icon name="key" size="28px" color="primary" />
          <div class="text-h6">Set up an encryption key</div>
        </q-card-section>

        <q-card-section class="q-pt-none text-body2">
          <p>
            This creates a passkey — your fingerprint, face or screen lock — and a key that never
            leaves your devices. Afterwards you can lock any single list, and its items are
            encrypted here before they are sent. The server stores text it cannot read.
          </p>
          <p>Nothing is locked by setting this up. Your lists stay exactly as they are.</p>
          <p class="text-weight-medium">
            If you lose every passkey you register — and the account they sync through — the locked
            lists are gone. Nobody can recover them, including me.
          </p>
          <p v-if="!platformAuthenticator" class="text-warning">
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
      </template>

      <!-- Key exists: the passkeys that can open it -->
      <template v-else>
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
            <q-item v-for="key in encryption.keys" :key="key.credential_id">
              <q-item-section avatar><q-icon name="key" color="grey-7" /></q-item-section>
              <q-item-section>
                <q-item-label>Passkey</q-item-label>
                <q-item-label caption>Added {{ addedOn(key) }}</q-item-label>
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
                  @click="remove(key)"
                />
              </q-item-section>
            </q-item>
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
      </template>
    </q-card>
  </q-dialog>
</template>

<script>
import { useEncryptionStore } from 'src/stores/encryption'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { hasPlatformAuthenticator } from 'src/utils/passkey'

/**
 * The key and its passkeys (§6) — reached from the ⋮ menu on the index.
 *
 * It creates and manages the key and nothing else. Which lists are encrypted is decided one
 * list at a time, in the list itself, which is why there is no "encrypt everything" button
 * here and no progress to report.
 *
 * Removing the key altogether is deliberately absent: with per-list encryption the way out is
 * to unlock the lists that are locked, one at a time, and the last remaining passkey is
 * refused by the server precisely so that stays possible.
 */
export default {
  name: 'EncryptionDialog',

  props: { modelValue: Boolean },

  emits: ['update:modelValue'],

  data() {
    return { error: '', platformAuthenticator: true }
  },

  computed: {
    encryption() {
      return useEncryptionStore()
    },

    lists() {
      return useShoppingListsStore()
    },

    open: {
      get() {
        return this.modelValue
      },
      set(value) {
        this.$emit('update:modelValue', value)
      },
    },

    /**
     * Locked lists, and whether this key is the only way into them.
     *
     * The server enforces the same rule and is the one that matters; this is only here so the
     * button says what it will do before it is pressed. With nothing locked, the last passkey is
     * removable — a key that opens nothing is not protecting anything.
     */
    lockedCount() {
      return this.lists.visibleLists.filter((l) => l.encrypted).length
    },

    lastOne() {
      return this.encryption.keys.length < 2 && this.lockedCount > 0
    },
  },

  async mounted() {
    this.platformAuthenticator = await hasPlatformAuthenticator()
  },

  methods: {
    addedOn(key) {
      return key.created_at ? new Date(key.created_at).toLocaleDateString() : 'this device'
    },

    /**
     * Every action here ends the same way: something to say, and it is always said.
     *
     * Including the cancelled-prompt case, which used to be swallowed as "they changed their mind".
     * The platform cannot tell that apart from "this device has no usable passkey" (see
     * `PasskeyCancelledError`), so staying quiet turned a real failure into a button that visibly
     * does nothing.
     */
    report(err, fallback) {
      this.error = err.message ?? fallback
    },

    async create() {
      this.error = ''
      try {
        await this.encryption.createKey()
        this.$q.notify({
          type: 'positive',
          message: 'Key created. Open a list and press the lock to encrypt it.',
        })
      } catch (err) {
        this.report(err, 'Could not create the key.')
      }
    },

    /**
     * Add a second passkey, unlocking first if this session is not holding the key.
     *
     * The unlock is not optional and cannot be skipped: the new passkey has to wrap *the same* data
     * key, so it has to be in hand. Nothing unlocks at boot any more (§1), so on most visits this is
     * two prompts in a row — one to open the key, one to create the credential. Doing it here rather
     * than telling the user to go and open a locked list first is the difference between a working
     * button and the dead end this was.
     */
    async addPasskey() {
      this.error = ''
      try {
        if (!this.encryption.unlocked) await this.encryption.unlock()
        await this.encryption.addPasskey()
        this.$q.notify({ type: 'positive', message: 'Passkey added.' })
      } catch (err) {
        this.report(err, 'Could not add that passkey.')
      }
    },

    /**
     * What removing this passkey actually costs, which is three different things.
     *
     * Worth the branch: the button is reachable in all three situations, and one sentence covering
     * them all ends up describing locked lists to someone who has none — true of nothing, and
     * alarming for no reason.
     *
     * No device name in any of them, because the app has none worth quoting — see `createKey`.
     */
    removalWarning() {
      if (this.encryption.keys.length < 2) {
        return (
          'This is the only passkey, so removing it leaves the account with no encryption key. ' +
          'Nothing is locked, so nothing becomes unreadable — but setting encryption up again ' +
          'later creates a different key.'
        )
      }
      if (this.lockedCount) {
        return (
          `This passkey will no longer open your ${this.lockedCount} locked list(s). Your other ` +
          'passkeys still will, and the lists themselves are untouched.'
        )
      }

      return 'This passkey will no longer be usable for lists you lock later. Your other passkeys will.'
    },

    remove(key) {
      // Answered on the tap rather than by grey-ing the button out: a disabled control explains
      // nothing, and this is the one refusal in the app that a user is entitled to a reason for.
      if (this.lastOne) {
        this.$q.dialog({
          title: 'This passkey cannot be removed',
          message:
            `It is the only one that can open your ${this.lockedCount} locked list(s), and ` +
            'removing it would leave them unopenable for good. Add a second passkey, or unlock ' +
            'those lists first.',
          ok: { label: 'OK', flat: true, noCaps: true },
        })

        return
      }

      this.$q.dialog({
        title: 'Remove passkey',
        message: this.removalWarning(),
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
