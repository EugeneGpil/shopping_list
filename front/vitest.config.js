import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// A deliberately small config rather than the Quasar testing app-extension: the tests cover
// the store's offline/sync logic, which is plain JS, so nothing here needs to know about
// Vue SFCs or the Quasar build. `quasar` is aliased to a stub because `sync.js` imports
// Notify from it and pulling in the real browser bundle would buy nothing.
export default defineConfig({
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
      quasar: fileURLToPath(new URL('./test/stubs/quasar.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.js'],
  },
})
