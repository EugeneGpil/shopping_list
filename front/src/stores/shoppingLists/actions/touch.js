import { privates } from '../privates'

/**
 * Record that the user has done something to the open list.
 *
 * Clears `pristine`, which is what stops a background refresh replacing rows under a caret —
 * see `_revalidate` and `refreshFromStorage`, the two things that ask.
 */
export default function _touch() {
  privates(this).pristine = false
}
