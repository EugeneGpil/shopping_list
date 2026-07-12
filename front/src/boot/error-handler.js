import { boot } from 'quasar/wrappers'
import { Notify } from 'quasar'

export default boot(() => {
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason
    const status = err?.status

    const message =
      status === 401 ? 'Session expired, please log in again' :
      status === 403 ? 'You don\'t have permission to do that' :
      status === 404 ? 'Resource not found' :
      status >= 500 ? 'Server error, try again later' :
      err?.message || 'Something went wrong'

    Notify.create({ type: 'negative', message })
  })
})