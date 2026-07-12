<template>
  <div class="column items-center justify-center q-pa-lg" style="min-height: 100vh">
    <div class="text-h4 text-weight-bold q-mb-xl">Forest</div>

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

    <q-btn
      class="full-width"
      color="blue-8"
      size="lg"
      unelevated
      rounded
      @click="loginWithFacebook"
    >
      <q-icon name="img:icons/facebook.svg" size="20px" class="q-mr-sm" />
      Continue with Facebook
    </q-btn>
  </div>
</template>

<script setup>
import { auth } from 'src/boot/firebase'
import { GoogleAuthProvider, FacebookAuthProvider, signInWithPopup } from 'firebase/auth'
import { useRouter } from 'vue-router'
import { useAuthStore } from 'src/stores/auth'
import { watch } from 'vue'

const router = useRouter()
const authStore = useAuthStore()

watch(() => authStore.isLoggedIn, (loggedIn) => {
  if (loggedIn) router.push('/')
}, { immediate: true })

async function loginWithGoogle() {
  const provider = new GoogleAuthProvider()
  await signInWithPopup(auth, provider).catch(() => {})
}

async function loginWithFacebook() {
  const provider = new FacebookAuthProvider()
  provider.addScope('public_profile')
  try {
    await signInWithPopup(auth, provider)
  } catch (e) {
    if (e.code === 'auth/account-exists-with-different-credential') {
      alert('An account already exists with this email. Please sign in with Google.')
    }
  }
}
</script>
