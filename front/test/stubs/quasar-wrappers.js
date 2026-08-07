// `quasar/wrappers` only exists to give boot files their types; at runtime `boot()` hands
// the function straight back. Standing it in lets a boot file be imported and called under
// plain vitest, with no Quasar build in the way.
export const boot = (fn) => fn
