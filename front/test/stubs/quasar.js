// Stands in for the Quasar plugin the store uses to tell the user about a conflict. The
// tests assert on what would have been shown, so the messages are recorded rather than
// rendered.
export const notifications = []

export const Notify = {
  create: (opts) => notifications.push(opts),
}
