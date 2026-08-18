/** One record by its local id, or undefined. Local id, never `serverId` — see `record.js`. */
export default function _find(id) {
  return this.lists.find((l) => l.id === id)
}
