<template>
  <q-dialog v-model="open" @hide="reset">
    <q-card style="width: 560px; max-width: 95vw">
      <q-card-section class="q-pb-none">
        <div class="text-h6">Import from Google Keep</div>
      </q-card-section>

      <!-- Step 1: no archive chosen yet. The export has to be requested from Google and
           takes a while to arrive, so the instructions stay on screen rather than hiding
           behind a help link. -->
      <q-card-section v-if="!candidates.length && !parsing">
        <p class="text-body2">
          Google Keep has no direct export, so the notes come from a Takeout archive:
        </p>
        <ol class="text-body2 q-pl-md">
          <li>
            Open
            <a class="takeout-link" href="https://takeout.google.com" target="_blank" rel="noopener"
              >takeout.google.com</a
            >
          </li>
          <li>Press <b>Deselect all</b>, then tick <b>Keep</b> only</li>
          <li>Export as a <b>.zip</b> and wait for Google's email</li>
        </ol>
        <q-file
          v-model="file"
          outlined
          dense
          accept=".zip"
          label="Choose the Takeout .zip"
          class="q-mt-md"
          :error="!!error"
          :error-message="error"
          @update:model-value="parse"
        >
          <template #prepend><q-icon name="folder_zip" /></template>
        </q-file>
        <p class="text-caption text-grey q-mt-sm q-mb-none">
          The archive is read on this device — nothing is uploaded.
        </p>
      </q-card-section>

      <q-card-section v-if="parsing" class="column items-center q-py-lg">
        <q-spinner size="32px" color="primary" />
        <div class="text-body2 q-mt-md">Reading the archive…</div>
      </q-card-section>

      <!-- Step 2: confirm what to import. Only active checklists get this far, so the list
           is short and starts fully ticked; the items are previewed because a Keep note is
           usually untitled and its name alone says nothing about what is in it. -->
      <template v-if="candidates.length && !parsing">
        <q-card-section class="q-py-sm row items-center">
          <div class="text-body2">
            {{ selectedCount }} of {{ candidates.length }} selected
            <span v-if="droppedTotal" class="text-grey">
              · {{ droppedTotal }} ticked-off item(s) will be skipped
            </span>
          </div>
          <q-space />
          <q-btn
            flat
            dense
            no-caps
            size="sm"
            :label="allSelected ? 'None' : 'All'"
            @click="toggleAll"
          />
        </q-card-section>

        <q-separator />

        <q-card-section class="q-pa-none" style="max-height: 45vh; overflow-y: auto">
          <q-list separator>
            <q-item v-for="c in candidates" :key="c.key" clickable @click="toggle(c)">
              <q-item-section side top>
                <q-checkbox :model-value="selected.has(c.key)" @update:model-value="toggle(c)" />
              </q-item-section>
              <q-item-section>
                <q-item-label>{{ c.title }}</q-item-label>
                <q-item-label caption lines="2">{{ c.items.join(', ') }}</q-item-label>
                <q-item-label caption class="text-grey-6">
                  {{ c.items.length }} item(s)
                  <span v-if="c.droppedChecked">· {{ c.droppedChecked }} ticked off, skipped</span>
                </q-item-label>
              </q-item-section>
            </q-item>
          </q-list>
        </q-card-section>

        <q-separator />
      </template>

      <q-card-actions align="right">
        <q-btn flat no-caps label="Cancel" @click="open = false" />
        <q-btn
          v-if="candidates.length"
          unelevated
          no-caps
          color="primary"
          :label="`Import ${selectedCount} list(s)`"
          :disable="!selectedCount"
          @click="confirm"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useQuasar } from 'quasar'
import { candidatesFromZip } from 'src/utils/keepNotes'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

const open = defineModel({ type: Boolean })

const $q = useQuasar()
const store = useShoppingListsStore()

const file = ref(null)
const parsing = ref(false)
const error = ref('')
const candidates = ref([])
const selected = ref(new Set())

const selectedCount = computed(() => selected.value.size)
const allSelected = computed(() => selectedCount.value === candidates.value.length)
const droppedTotal = computed(() =>
  candidates.value
    .filter((c) => selected.value.has(c.key))
    .reduce((sum, c) => sum + c.droppedChecked, 0),
)

function reset() {
  file.value = null
  parsing.value = false
  error.value = ''
  candidates.value = []
  selected.value = new Set()
}

async function parse(picked) {
  if (!picked) return
  parsing.value = true
  error.value = ''
  try {
    const found = await candidatesFromZip(await picked.arrayBuffer())
    candidates.value = found
    // Everything listed is an active checklist, which is what someone importing into a
    // shopping app came for — so the work left is unticking, not ticking.
    selected.value = new Set(found.map((c) => c.key))
  } catch (err) {
    // The archive is the user's to fix — a wrong export, or a file that is not one at all —
    // so say which it was rather than a generic failure.
    error.value = err.message || 'Could not read this archive.'
    file.value = null
  } finally {
    parsing.value = false
  }
}

function toggle(candidate) {
  const next = new Set(selected.value)
  if (!next.delete(candidate.key)) next.add(candidate.key)
  selected.value = next
}

function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(candidates.value.map((c) => c.key))
}

function confirm() {
  const chosen = candidates.value.filter((c) => selected.value.has(c.key))
  store.importLists(chosen)
  open.value = false
  // The lists exist locally the moment they are added, so this is already true offline;
  // `sync` is what gets them to the server, whenever that becomes possible.
  $q.notify({
    type: 'positive',
    message: `Imported ${chosen.length} list(s).`,
  })
  store.sync()
}
</script>

<style scoped>
/* The browser's default link blue is all but invisible on the dark card. Inheriting the
   card's own colour keeps it legible in both themes; the underline is what still marks it
   as a link. */
.takeout-link {
  color: inherit;
  text-decoration: underline;
}
</style>
