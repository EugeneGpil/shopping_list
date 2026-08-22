/**
 * The two phrases the trash needs about time, and the arithmetic behind them.
 *
 * Both dates come from the server (`deleted_at`, `purge_at`), so the countdown shown here and
 * the deletion the nightly prune performs are the same window — the client never works out
 * when a list expires, it only renders what it was told.
 *
 * Days rather than dates, because that is the question being asked: "how long have I still
 * got", not "on which afternoon does this vanish".
 */
const DAY = 86400000

/**
 * How long the trash keeps a list, for the one sentence that has to say it *before* anything is
 * deleted: the confirmation on the index page.
 *
 * A literal, and deliberately the only one. The server owns this number
 * (`config('trash.retention_days')`) and tells the client the dates it produces — `deleted_at`
 * and `purge_at` on every trash entry — but it has nothing to tell about a list that is still
 * alive, and there is no endpoint that reports the setting itself. Deriving it from an existing
 * entry's two dates would make the wording depend on whether the trash happens to be empty, and
 * an empty trash is exactly the state a first delete is confirmed from. So it is stated here,
 * next to the rest of the trash's arithmetic, and it is wrong only if the server's window is
 * changed — at which point this line is the one place to follow it.
 */
export const RETENTION_DAYS = 60

/** Whole days left before a list is removed for good. Can be zero or negative — see below. */
export function daysLeft(purgeAt) {
  if (!purgeAt) return null

  return Math.ceil((new Date(purgeAt).getTime() - Date.now()) / DAY)
}

/**
 * How long this list has left, for the caption under its name.
 *
 * "any time now" covers a window that has already run out: the prune is a daily job, so a list
 * can be past its date and still here for a few hours. Promising a day it no longer has would
 * be the one wrong thing to say to somebody deciding whether to restore it.
 */
export function deletesIn(purgeAt) {
  const days = daysLeft(purgeAt)
  if (days === null) return ''
  if (days <= 0) return 'deletes any time now'
  if (days === 1) return 'deletes tomorrow'

  return `deletes in ${days} days`
}

/** When it was deleted, in the same units. */
export function deletedAgo(deletedAt) {
  if (!deletedAt) return ''
  const days = Math.floor((Date.now() - new Date(deletedAt).getTime()) / DAY)
  if (days <= 0) return 'Deleted today'
  if (days === 1) return 'Deleted yesterday'

  return `Deleted ${days} days ago`
}
