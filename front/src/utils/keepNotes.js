import { readZipEntries } from './zipEntries'

/**
 * Turning a Google Takeout export into importable lists.
 *
 * Keep stores a note as either a checklist or one block of text, and both are offered. A
 * text note becomes one item per line, which is a guess about what the note is — in a real
 * archive plenty of them are passwords, links and running logs — so the two kinds are kept
 * apart as `kind` and the dialog leaves the text ones unticked by default.
 *
 * The other judgement: **checked items are dropped**. In Keep a ticked item is something
 * already bought, so carrying them over would import a list of things not to buy.
 *
 * This is the only implementation of these rules. A second one existed as an artisan
 * command for the first import and was removed once this replaced it — two parsers of the
 * same file format drifted apart twice in a single afternoon.
 */

const MAX_NAME = 255

const isKeepNote = (name) => name.includes('/Keep/') && name.endsWith('.json')

const clean = (text) =>
  String(text ?? '')
    .trim()
    .slice(0, MAX_NAME)

/** Untitled notes are the common case in Keep, so date them to tell them apart. */
function fallbackTitle(note) {
  const usec = Number(note.createdTimestampUsec ?? 0)
  if (!usec) return 'Keep note'
  const d = new Date(usec / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  return `Keep ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** One note as an import candidate, or null when it is not one. */
export function noteToCandidate(note, key) {
  // Trashed notes are gone as far as the user is concerned; importing them would resurrect
  // something they deleted. Archived ones are put away rather than deleted, but they are
  // just as much not what someone is importing — and in a real export they outnumber the
  // active notes many times over, which buries the handful worth picking.
  if (!note || note.isTrashed || note.isArchived) return null

  const checklist = Array.isArray(note.listContent)
  if (!checklist && typeof note.textContent !== 'string') return null

  const items = checklist
    ? note.listContent
        .filter((entry) => !entry?.isChecked)
        .map((entry) => clean(entry?.text))
        .filter(Boolean)
    : // Blank lines are how a text note gets its paragraphs; they are separators, not items.
      note.textContent.split(/\r\n|\r|\n/).map(clean).filter(Boolean)

  // Everything on it was ticked off, or the note is empty — nothing left to import.
  if (!items.length) return null

  return {
    key,
    kind: checklist ? 'list' : 'text',
    title: clean(note.title) || fallbackTitle(note),
    items,
    // Shown so a short list is not mistaken for the whole note.
    droppedChecked: checklist ? note.listContent.filter((entry) => entry?.isChecked).length : 0,
  }
}

/**
 * Candidates from a Takeout `.zip`, newest note first.
 *
 * Rejects a zip with no Keep notes rather than returning nothing, because "0 lists found"
 * and "you picked the wrong export" look identical on screen and are fixed differently.
 */
export async function candidatesFromZip(arrayBuffer) {
  const entries = await readZipEntries(arrayBuffer, isKeepNote)
  if (!entries.length) {
    throw new Error('No Google Keep notes in this archive.')
  }

  const candidates = []
  for (const entry of entries) {
    let note
    try {
      note = JSON.parse(entry.text)
    } catch {
      // Keep also ships Labels.json and other shapes; one unreadable file is not a reason
      // to fail the whole import.
      continue
    }
    const candidate = noteToCandidate(note, entry.name)
    if (candidate)
      candidates.push({ ...candidate, createdAt: Number(note.createdTimestampUsec ?? 0) })
  }

  // Checklists first, then the text notes, each newest first: the two kinds are ticked as
  // groups in the dialog, and a group checkbox over rows scattered through the list is a
  // checkbox whose effect you cannot see.
  candidates.sort((a, b) =>
    a.kind === b.kind ? b.createdAt - a.createdAt : a.kind === 'list' ? -1 : 1,
  )
  return candidates
}
