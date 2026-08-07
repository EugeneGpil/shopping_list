<template>
  <!-- The one thing the app cannot solve on its own. Every other failure here is either
       retried silently or shown next to the thing that failed; this one needs the user, so
       it sits above both pages until it is dealt with rather than passing by as a toast. -->
  <q-banner v-if="authStore.sessionExpired" dense class="bg-warning text-dark">
    <template #avatar>
      <q-icon name="lock_clock" />
    </template>
    Your session has expired. Your changes are saved on this device — sign in again to sync them.
    <template #action>
      <q-btn flat dense no-caps :loading="signingIn" label="Sign in again" @click="signIn" />
    </template>
  </q-banner>
</template>

<script setup>
import { ref } from 'vue'
import { useAuthStore } from 'src/stores/auth'

const authStore = useAuthStore()

const signingIn = ref(false)

// A closed popup or a second refusal leaves the flag up, which is right: nothing has been
// fixed, so the banner stays. The store has already said what it can about why.
async function signIn() {
  signingIn.value = true
  try {
    await authStore.signInAgain()
  } finally {
    signingIn.value = false
  }
}
</script>
