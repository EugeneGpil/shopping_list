/**
 * The order of the collection, when two devices disagree about it.
 *
 * `orderDirty` is a reorder of ours the server has not been told about, and it outranks every
 * order anyone else states — the same principle `_applyIndexEntry` applies to content, where a
 * `dirty` record ignores what the index says about it. Whatever the other side knows about and
 * we do not goes to the end rather than being dropped: it is a real list, and the user can drag
 * it where they want it.
 *
 * Both callers of this hold the same obligation from opposite sides — `refreshFromStorage` for
 * another tab's write, `_fetchIndex` for the server's index — so it is stated here once.
 */
export function orderedLike(lists, reference) {
  const rank = new Map(reference.map((l, i) => [l.id, i]))
  const last = rank.size
  // Stable, so everything unranked keeps the relative order it arrived in.
  return [...lists].sort((a, b) => (rank.get(a.id) ?? last) - (rank.get(b.id) ?? last))
}
