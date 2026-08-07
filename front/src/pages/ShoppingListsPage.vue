<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <q-form class="row items-center q-gutter-sm q-mb-lg" @submit.prevent="create">
      <q-input
        v-model="newName"
        outlined
        dense
        autogrow
        class="col"
        placeholder="New list name"
        maxlength="255"
        @keydown.enter.prevent="create"
      />
      <q-btn
        type="submit"
        color="primary"
        icon="add"
        label="Create"
        :disable="!newName.trim() || creating"
        :loading="creating"
        unelevated
      />
      <q-btn flat round icon="logout" @click="onLogout" />
    </q-form>

    <q-inner-loading :showing="loading" />

    <!-- The two directions, and they are independent: this one is what we may not have
         heard from the server, the one below is what the server has not heard from us. -->
    <StaleDataNotice />

    <!-- Changes are kept locally and pushed when there is a connection, so the only thing
         worth saying is that some are still waiting. Silence would read as "saved". -->
    <div v-if="store.pendingCount" class="row items-center q-gutter-xs q-mb-sm text-grey">
      <q-spinner v-if="store.syncing" size="14px" />
      <q-icon v-else name="cloud_off" size="16px" />
      <span class="text-caption">
        {{ store.syncing ? 'Syncing…' : `${store.pendingCount} change(s) waiting to sync` }}
      </span>
    </div>

    <!-- Only reachable with nothing cached to fall back on: with lists in the store they
         are shown instead, stale at worst. -->
    <div v-if="loadFailed && !store.visibleLists.length" class="text-center q-mt-xl">
      <q-icon name="cloud_off" size="48px" color="grey-6" />
      <div class="text-subtitle1 q-mt-sm">Can't load your lists</div>
      <q-btn
        outline
        no-caps
        color="primary"
        label="Retry"
        class="q-mt-md"
        :loading="loading"
        @click="load"
      />
    </div>

    <div v-else-if="!loading && !store.visibleLists.length" class="text-grey text-center q-mt-xl">
      No lists yet. Create your first one above.
    </div>

    <!-- `update:model-value` rather than `v-model`: the new order goes back through an
         action, which is also what persists it. Bound to the visible lists, so a list
         waiting to be deleted on the server is not in the order the user drags. -->
    <draggable
      :model-value="store.visibleLists"
      item-key="id"
      handle=".drag-handle"
      :animation="150"
      :force-fallback="true"
      class="q-list q-list--bordered q-list--separator rounded-borders"
      @update:model-value="store.reorderLists"
    >
      <template #item="{ element: list }">
        <q-item clickable v-ripple class="q-pl-none" @click="open(list.id)">
          <q-item-section side style="width: 32px; min-width: 32px" class="items-center">
            <q-icon name="drag_indicator" class="drag-handle" color="grey-6" @click.stop />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ list.name }}</q-item-label>
            <q-item-label caption>{{ list.items_count }} item(s)</q-item-label>
          </q-item-section>
          <q-item-section side style="width: 20px; min-width: 20px" class="q-pl-none">
            <q-btn
              flat
              round
              dense
              size="sm"
              padding="none"
              tabindex="-1"
              icon="delete"
              color="negative"
              @click.stop="remove(list)"
            />
          </q-item-section>
        </q-item>
      </template>
    </draggable>
  </q-page>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useQuasar } from 'quasar'
import draggable from 'vuedraggable'
import { isNetworkError } from 'src/api'
import StaleDataNotice from 'src/components/StaleDataNotice.vue'
import { useRetryWhenOnline } from 'src/composables/useRetryWhenOnline'
import { useAuthStore } from 'src/stores/auth'
import { useShoppingListsStore } from 'src/stores/shoppingLists'

const router = useRouter()
const $q = useQuasar()
const authStore = useAuthStore()
const store = useShoppingListsStore()

const newName = ref('')
const loading = ref(false)
const creating = ref(false)
const loadFailed = ref(false)

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    await store.fetchLists()
  } catch (err) {
    // Offline with lists already in the store: keep showing them. They are the same
    // records the editor works on, so at worst they are a little stale — while an empty
    // page would suggest the lists are gone.
    if (!isNetworkError(err) || !store.visibleLists.length) loadFailed.value = true
  } finally {
    loading.value = false
  }
}

async function create() {
  const name = newName.value.trim()
  if (!name || creating.value) return
  creating.value = true
  try {
    // Succeeds offline too — the list is created locally and pushed later — so the only
    // way here is a refusal from the server, e.g. a name it will not accept.
    const list = await store.createList(name)
    newName.value = ''
    router.push(`/list/${list.id}`)
  } catch {
    // Nothing was created, so there is nothing to undo — keep the typed name so the
    // button can simply be pressed again.
    $q.notify({ type: 'negative', message: 'Could not create the list.' })
  } finally {
    creating.value = false
  }
}

function open(id) {
  router.push(`/list/${id}`)
}

function remove(list) {
  $q.dialog({
    title: 'Delete list',
    message: `Delete "${list.name}"? This cannot be undone.`,
    cancel: true,
    ok: { label: 'Delete', color: 'negative' },
  }).onOk(async () => {
    // The row goes immediately either way; offline the deletion is queued, which needs no
    // announcement. Only the server actively refusing is worth a word.
    if ((await store.deleteList(list.id)) === 'failed') {
      $q.notify({ type: 'negative', message: 'Could not delete the list.' })
    }
  })
}

// Only worth a retry if the last attempt actually failed — a successful index does not
// need refetching just because the connection blinked. `stale` is part of that: falling
// back to the cached lists leaves `loadFailed` false, and without this the notice saying
// they are unconfirmed would still be true and never get a chance to stop being true.
useRetryWhenOnline(() => {
  if (loadFailed.value || store.stale) load()
})

async function onLogout() {
  await authStore.logout()
  // The lists outlive this page, so they have to go explicitly — otherwise the next
  // person to sign in sees them until their own fetch lands.
  store.clear()
  router.push('/login')
}

onMounted(load)
</script>

<style scoped>
.drag-handle {
  cursor: grab;
}
.drag-handle:active {
  cursor: grabbing;
}
</style>
