/**
 * Flag the open list as holding content the server has not accepted yet.
 *
 * The flag *is* the queue: `sync` looks for nothing else. See `record.js`.
 */
export default function _markDirty() {
  if (this.current) this.current.dirty = true
}
