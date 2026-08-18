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

      <!-- Step 2: confirm what to import. The items are previewed because a Keep note is
           usually untitled and its name alone says nothing about what is in it, and the two
           kinds are ticked as groups — an archive can hold dozens of text notes and picking
           through them one by one is the slow way to say "all of them" or "none". -->
      <template v-if="candidates.length && !parsing">
        <q-card-section class="q-py-sm">
          <div class="text-body2">
            {{ selectedCount }} of {{ candidates.length }} selected
            <span v-if="droppedTotal" class="text-grey">
              · {{ droppedTotal }} ticked-off item(s) will be skipped
            </span>
          </div>
          <div class="row items-center q-gutter-x-md q-mt-xs">
            <q-checkbox
              v-for="g in groups"
              :key="g.kind"
              dense
              size="sm"
              :model-value="groupState(g)"
              :label="`All ${g.label.toLowerCase()} (${g.candidates.length})`"
              @update:model-value="toggleGroup(g)"
            />
          </div>
        </q-card-section>

        <q-separator />

        <q-card-section class="q-pa-none" style="max-height: 45vh; overflow-y: auto">
          <q-list separator>
            <template v-for="g in groups" :key="g.kind">
              <!-- Named only when both kinds are present; over a single group the heading
                   is a label for something there is no alternative to. -->
              <q-item-label v-if="groups.length > 1" header class="q-py-sm">
                {{ g.label }}
              </q-item-label>
              <q-item v-for="c in g.candidates" :key="c.key" clickable @click="toggle(c)">
                <q-item-section side top>
                  <q-checkbox :model-value="selected.has(c.key)" @update:model-value="toggle(c)" />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ c.title }}</q-item-label>
                  <q-item-label caption lines="2">{{ c.items.join(', ') }}</q-item-label>
                  <q-item-label caption class="text-grey-6">
                    {{ c.items.length }} {{ c.kind === 'text' ? 'line(s)' : 'item(s)' }}
                    <span v-if="c.droppedChecked"
                      >· {{ c.droppedChecked }} ticked off, skipped</span
                    >
                  </q-item-label>
                </q-item-section>
              </q-item>
            </template>
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

<script>
import { candidatesFromZip } from 'src/utils/keepNotes'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

export default {
  name: 'ImportFromKeepDialog',

  props: { modelValue: Boolean },

  emits: ['update:modelValue'],

  data() {
    return {
      file: null,
      parsing: false,
      error: '',
      candidates: [],
      selected: new Set(),
    }
  },

  computed: {
    store() {
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

    selectedCount() {
      return this.selected.size
    },

    /** Only the kinds this archive actually holds, so an empty group is never offered. */
    groups() {
      return [
        { kind: 'list', label: 'Lists', candidates: this.ofKind('list') },
        { kind: 'text', label: 'Plain text notes', candidates: this.ofKind('text') },
      ].filter((g) => g.candidates.length)
    },

    droppedTotal() {
      return this.candidates
        .filter((c) => this.selected.has(c.key))
        .reduce((sum, c) => sum + c.droppedChecked, 0)
    },
  },

  methods: {
    ofKind(kind) {
      return this.candidates.filter((c) => c.kind === kind)
    },

    /** `null` is Quasar's indeterminate — the honest state when only some of a group is on. */
    groupState(group) {
      const on = group.candidates.filter((c) => this.selected.has(c.key)).length
      if (!on) return false
      return on === group.candidates.length ? true : null
    },

    toggleGroup(group) {
      const next = new Set(this.selected)
      // Partly-on reads as "not all of it yet", so the useful move is to finish selecting it.
      const turnOn = this.groupState(group) !== true
      for (const c of group.candidates) {
        if (turnOn) next.add(c.key)
        else next.delete(c.key)
      }
      this.selected = next
    },

    reset() {
      this.file = null
      this.parsing = false
      this.error = ''
      this.candidates = []
      this.selected = new Set()
    },

    async parse(picked) {
      if (!picked) return
      this.parsing = true
      this.error = ''
      try {
        const found = await candidatesFromZip(await picked.arrayBuffer())
        this.candidates = found
        // A checklist is what someone importing into a shopping app came for, so those start
        // ticked. A text note only became a list by splitting it on newlines — that guess is
        // the user's to confirm, and in an archive of any size most of them are not shopping.
        // Unless they are all there is, in which case starting with nothing selected would be
        // an empty dialog over a file the user picked on purpose.
        const lists = found.filter((c) => c.kind === 'list')
        this.selected = new Set((lists.length ? lists : found).map((c) => c.key))
      } catch (err) {
        // The archive is the user's to fix — a wrong export, or a file that is not one at all —
        // so say which it was rather than a generic failure.
        this.error = err.message || 'Could not read this archive.'
        this.file = null
      } finally {
        this.parsing = false
      }
    },

    toggle(candidate) {
      const next = new Set(this.selected)
      if (!next.delete(candidate.key)) next.add(candidate.key)
      this.selected = next
    },

    confirm() {
      const chosen = this.candidates.filter((c) => this.selected.has(c.key))
      this.store.importLists(chosen)
      this.open = false
      // The lists exist locally the moment they are added, so this is already true offline;
      // `sync` is what gets them to the server, whenever that becomes possible.
      this.$q.notify({
        type: 'positive',
        message: `Imported ${chosen.length} list(s).`,
      })
      this.store.sync()
    },
  },
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
