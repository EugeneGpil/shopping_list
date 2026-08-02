<template>
  <q-page class="q-pa-md" style="max-width: 720px; margin: 0 auto">
    <q-form class="row items-center q-gutter-sm q-mb-lg" @submit.prevent="create">
      <q-input
        v-model="newName"
        outlined
        dense
        class="col"
        placeholder="New list name"
        maxlength="255"
      />
      <q-btn
        type="submit"
        color="primary"
        icon="add"
        label="Create"
        :disable="!newName.trim()"
        unelevated
      />
      <q-btn flat round icon="logout" @click="onLogout" />
    </q-form>

    <q-inner-loading :showing="loading" />

    <div v-if="!loading && lists.length === 0" class="text-grey text-center q-mt-xl">
      No lists yet. Create your first one above.
    </div>

    <draggable
      v-model="lists"
      item-key="id"
      handle=".drag-handle"
      :animation="150"
      :force-fallback="true"
      class="q-list q-list--bordered q-list--separator rounded-borders"
      @end="persistOrder"
    >
      <template #item="{ element: list }">
        <q-item clickable v-ripple class="q-pl-none" @click="open(list.id)">
          <q-item-section side style="width: 32px; min-width: 32px" class="items-center">
            <q-icon
              name="drag_indicator"
              class="drag-handle"
              color="grey-6"
              @click.stop
            />
          </q-item-section>
          <q-item-section>
            <q-item-label>{{ list.name }}</q-item-label>
            <q-item-label caption>{{ list.items_count }} item(s)</q-item-label>
          </q-item-section>
          <q-item-section side style="width: 20px; min-width: 20px" class="q-pl-none">
            <q-btn
              flat round dense
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
import { api } from 'src/api'
import { useAuthStore } from 'src/stores/auth'

const router = useRouter()
const $q = useQuasar()
const authStore = useAuthStore()

const lists = ref([])
const newName = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const { data } = await api.get('shopping-lists')
    lists.value = data
  } finally {
    loading.value = false
  }
}

async function create() {
  const name = newName.value.trim()
  if (!name) return
  const { data } = await api.post('shopping-lists', { name })
  newName.value = ''
  router.push(`/list/${data.id}`)
}

function open(id) {
  router.push(`/list/${id}`)
}

async function persistOrder() {
  const ids = lists.value.map((l) => l.id)
  await api.put('shopping-lists/order', { ids }).catch(() => {})
}

function remove(list) {
  $q.dialog({
    title: 'Delete list',
    message: `Delete "${list.name}"? This cannot be undone.`,
    cancel: true,
    ok: { label: 'Delete', color: 'negative' },
  }).onOk(async () => {
    await api.del(`shopping-list?list_id=${list.id}`)
    lists.value = lists.value.filter((l) => l.id !== list.id)
  })
}

async function onLogout() {
  await authStore.logout()
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
