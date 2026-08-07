import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// A deliberately small config rather than the Quasar testing app-extension: the tests cover
// the store's offline/sync logic and the global error handler, which are plain JS, so
// nothing here needs to know about Vue SFCs or the Quasar build. `quasar` is aliased to a
// stub because those files import Notify from it and pulling in the real browser bundle
// would buy nothing.
export default defineConfig({
  resolve: {
    alias: {
      src: fileURLToPath(new URL('./src', import.meta.url)),
      // Before the bare `quasar` entry: aliases match by prefix, so that one would
      // otherwise turn `quasar/wrappers` into a path inside the Notify stub.
      'quasar/wrappers': fileURLToPath(new URL('./test/stubs/quasar-wrappers.js', import.meta.url)),
      quasar: fileURLToPath(new URL('./test/stubs/quasar.js', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.js'],
  },
})
