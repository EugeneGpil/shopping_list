<template>
  <q-dialog v-model="open" @hide="onHide">
    <q-card style="max-width: 460px">
      <!-- Not set up yet -->
      <template v-if="!encryption.enabled">
        <q-card-section class="row items-center q-gutter-sm">
          <q-icon name="lock" size="28px" color="primary" />
          <div class="text-h6">Encrypt your lists</div>
        </q-card-section>

        <q-card-section class="q-pt-none text-body2">
          <p>
            Your lists are encrypted on this device before they are sent. The server stores text it
            cannot read, and neither can anyone with a copy of its database or its backups.
          </p>
          <p class="text-weight-medium">
            The key never leaves your devices. If you lose every passkey you have registered — and
            the account they sync through — the lists are gone. Nobody can recover them, including
            me.
          </p>
          <p>
            This does not protect a phone somebody is holding unlocked: the copy kept on the device
            stays readable so the app still works offline.
          </p>
          <p v-if="!platformAuthenticator" class="text-warning">
            This device has no built-in fingerprint or screen-lock authenticator, so you will need a
            security key.
          </p>
          <p v-if="lists.pendingCount" class="text-warning">
            {{ lists.pendingCount }} change(s) have not reached the server yet. They are sent first
            — if that fails, turning encryption on now can cost another device's queued edits.
          </p>
        </q-card-section>

        <q-card-section v-if="error" class="q-pt-none text-negative text-body2">
          {{ error }}
        </q-card-section>

        <q-card-section v-if="encryption.progress" class="q-pt-none">
          <q-linear-progress :value="fraction" color="primary" class="q-mb-xs" />
          <div class="text-caption">
            {{ encryption.progress.done }} of {{ encryption.progress.total }} list(s) converted
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat no-caps label="Not now" v-close-popup :disable="encryption.busy" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            icon="fingerprint"
            label="Turn on encryption"
            :loading="encryption.busy"
            @click="enable"
          />
        </q-card-actions>
      </template>

      <!-- Already on -->
      <template v-else>
        <q-card-section class="row items-center q-gutter-sm">
          <q-icon name="lock" size="28px" color="positive" />
          <div class="text-h6">Encryption is on</div>
        </q-card-section>

        <q-card-section v-if="encryption.needsSecondPasskey" class="q-pt-none text-body2">
          <q-banner dense class="bg-orange-1 text-orange-10 rounded-borders">
            One passkey opens these lists. Register a second one — on your laptop, or another phone
            — while you still can: it is the only way back if this one is lost.
          </q-banner>
        </q-card-section>

        <q-card-section class="q-pt-none">
          <q-list dense separator>
            <q-item v-for="key in encryption.keys" :key="key.credential_id">
              <q-item-section avatar><q-icon name="key" color="grey-7" /></q-item-section>
              <q-item-section>
                <q-item-label>{{ key.label || 'Passkey' }}</q-item-label>
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
                  :disable="encryption.keys.length < 2 || encryption.busy"
                  @click="remove(key)"
                />
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <q-card-section v-if="unconverted" class="q-pt-none text-body2 text-warning">
          {{ unconverted }} list(s) are still stored as plain text — the last pass stopped early.
        </q-card-section>

        <q-card-section v-if="error" class="q-pt-none text-negative text-body2">
          {{ error }}
        </q-card-section>

        <q-card-actions align="right">
          <q-btn flat no-caps label="Close" v-close-popup :disable="encryption.busy" />
          <q-btn
            v-if="unconverted"
            flat
            no-caps
            color="primary"
            label="Finish converting"
            :loading="encryption.busy"
            @click="resume"
          />
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

<script setup>
import { computed, onMounted, ref } from 'vue'
import { useQuasar } from 'quasar'
import { useEncryptionStore } from 'src/stores/encryption'
import { useShoppingListsStore } from 'src/stores/shoppingLists'
import { hasPlatformAuthenticator } from 'src/utils/passkey'

/**
 * Setting encryption up, and everything about it afterwards (§6).
 *
 * One dialog for both states because they are the same subject and the answer to "is it on?"
 * is what the user came here for. The warnings on the left-hand branch are §0 and §10 stated
 * in the words the doc asks for: no recovery, and the device cache stays readable.
 *
 * Turning encryption *off* is deliberately absent — §1 decided it must be possible, but the
 * flow (fresh unlock, decrypt everything, drop every wrapped key) is not built yet, and a
 * button that half-works here would be a way to lose data rather than a way out.
 */

const props = defineProps({ modelValue: Boolean })
const emit = defineEmits(['update:modelValue'])

const $q = useQuasar()
const encryption = useEncryptionStore()
const lists = useShoppingListsStore()

const error = ref('')
const platformAuthenticator = ref(true)

const open = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

const fraction = computed(() => {
  const { done, total } = encryption.progress ?? {}
  return total ? done / total : 0
})

/** Lists the server still holds in the clear — what a resumed pass has left to do. */
const unconverted = computed(() => (encryption.enabled ? lists.notYetEncrypted().length : 0))

const addedOn = (key) =>
  key.created_at ? new Date(key.created_at).toLocaleDateString() : 'this device'

const deviceLabel = () => {
  const ua = navigator.userAgent
  const platform = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'Mac'
          : 'Linux'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua)
      ? 'Chrome'
      : /Safari\//.test(ua)
        ? 'Safari'
        : 'Browser'

  return `${browser} on ${platform}`
}

onMounted(async () => {
  platformAuthenticator.value = await hasPlatformAuthenticator()
})

/** Every action here ends the same way: the prompt was dismissed, or something to say. */
function report(err, fallback) {
  if (err.name === 'PasskeyCancelledError') return
  error.value = err.message ?? fallback
}

async function enable() {
  error.value = ''
  try {
    const { total, done, stopped } = await encryption.enable(deviceLabel())
    if (stopped) {
      error.value =
        `Converted ${done} of ${total} list(s), then stopped: ` +
        `${stopped === 'offline' ? 'no connection' : stopped}. ` +
        'Your key is saved — open this dialog again to finish.'
      return
    }
    $q.notify({ type: 'positive', message: `Encrypted ${done} list(s).` })
  } catch (err) {
    report(err, 'Could not turn encryption on.')
  }
}

async function resume() {
  error.value = ''
  try {
    const { total, done, stopped } = await encryption.runPass()
    if (stopped) error.value = `Converted ${done} of ${total} list(s), then stopped: ${stopped}.`
  } catch (err) {
    report(err, 'Could not finish converting.')
  }
}

async function addPasskey() {
  error.value = ''
  try {
    await encryption.addPasskey(deviceLabel())
    $q.notify({ type: 'positive', message: 'Passkey added.' })
  } catch (err) {
    report(err, 'Could not add that passkey.')
  }
}

function remove(key) {
  $q.dialog({
    title: 'Remove passkey',
    message: `"${key.label || 'This passkey'}" will no longer open your lists. The lists themselves are untouched.`,
    cancel: true,
    ok: { label: 'Remove', color: 'negative' },
  }).onOk(async () => {
    error.value = ''
    try {
      await encryption.removePasskey(key.credential_id)
    } catch (err) {
      // 409 is the server refusing to leave this account with no way in at all.
      error.value = err.body?.message ?? 'Could not remove that passkey.'
    }
  })
}

function onHide() {
  error.value = ''
  encryption.progress = null
}
</script>
