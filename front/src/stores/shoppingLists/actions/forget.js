/**
 * Drop a record from the collection entirely.
 *
 * Only for a list that is gone for good — the server accepted the delete, or answered 404. A
 * list merely waiting to be deleted keeps its tombstone instead, or the queue would be lost.
 */
export default function _forget(id) {
  this.lists = this.lists.filter((l) => l.id !== id)
}
