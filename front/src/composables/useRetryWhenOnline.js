import { onMounted, onBeforeUnmount } from 'vue'

/**
 * Call `retry` when the browser comes back online.
 *
 * That is the exact moment a load which failed offline can succeed, so take it instead
 * of leaving the user to press a button. Whether there is anything worth retrying is the
 * caller's decision — this fires on every transition to online.
 */
export function useRetryWhenOnline(retry) {
  onMounted(() => window.addEventListener('online', retry))
  onBeforeUnmount(() => window.removeEventListener('online', retry))
}
