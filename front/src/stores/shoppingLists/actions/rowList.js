/**
 * The open list's rows, or null when nothing is open or nothing is loaded yet.
 *
 * Distinct from the `items` getter, whose `[]` is for rendering — here the null is the guard
 * every row action and every history snapshot checks before touching anything.
 */
export default function _rowList() {
  return this.current?.items ?? null
}
