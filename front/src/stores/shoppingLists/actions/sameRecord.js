import { forStorage } from '../record'

/**
 * Whether two copies of a list say the same thing.
 *
 * Compared in storage shape, on both sides: item `_key`s are per-session and mean nothing
 * across tabs, and `forStorage` is already the thing that drops them. Used by
 * `refreshFromStorage` to tell a real change from another tab writing back what we already have
 * — which is what stops two tabs writing at each other forever.
 */
export default function _sameRecord(a, b) {
  return JSON.stringify(forStorage([a])) === JSON.stringify(forStorage([b]))
}
