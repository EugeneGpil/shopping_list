/**
 * Call the component's `retryWhenOnline()` when the browser comes back online.
 *
 * That is the exact moment a load which failed offline can succeed, so take it instead
 * of leaving the user to press a button. Whether there is anything worth retrying is the
 * component's decision — this fires on every transition to online.
 */
export default {
  mounted() {
    window.addEventListener('online', this.retryWhenOnline)
  },

  beforeUnmount() {
    window.removeEventListener('online', this.retryWhenOnline)
  },
}
