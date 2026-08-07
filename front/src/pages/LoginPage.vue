<template>
  <div class="column items-center justify-center q-pa-lg" style="min-height: 100vh">
    <div class="text-h4 text-weight-bold q-mb-xl">Shopping list</div>

    <q-btn
      class="full-width q-mb-md"
      color="white"
      text-color="dark"
      size="lg"
      unelevated
      rounded
      @click="loginWithGoogle"
    >
      <q-icon name="img:icons/google.svg" size="20px" class="q-mr-sm" />
      Continue with Google
    </q-btn>
  </div>
</template>

<script setup>
import { watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from 'src/stores/auth'

const router = useRouter()
const authStore = useAuthStore()

watch(
  () => authStore.isLoggedIn,
  (loggedIn) => {
    if (loggedIn) router.push('/')
  },
  { immediate: true },
)

// The popup itself lives in the store, because the expired-session banner signs in the
// same way and there must not be two versions of what "sign in" means.
const loginWithGoogle = () => authStore.loginWithGoogle()
</script>
