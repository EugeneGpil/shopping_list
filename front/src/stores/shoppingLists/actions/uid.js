import { useAuthStore } from 'src/stores/auth'

/**
 * Who the cached copy on this device belongs to.
 *
 * Read at the moment it is needed rather than captured once: localStorage outlives a logout, so
 * every read and write has to be scoped to whoever is signed in *now* — see `storage.js`.
 */
export default function _uid() {
  return useAuthStore().user?.uid
}
