import { readZipEntries } from './zipEntries'

/**
 * Turning a Google Takeout export into importable lists.
 *
 * Only Keep's **checklists** are offered — a note it stored as one block of text has no
 * items, and splitting it on newlines is a guess about what the note even is. In a real
 * archive those are overwhelmingly passwords, links and running logs, so they are left out
 * rather than listed and unticked.
 *
 * The other judgement: **checked items are dropped**. In Keep a ticked item is something
 * already bought, so carrying them over would import a list of things not to buy.
 *
 * `back/app/Console/Commands/ImportKeepNotes.php` does the same job from the command line
 * and agrees on all of this by default — it can additionally be asked for the text notes
 * (`--text`) and the archived ones (`--archived`), which have no equivalent here.
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
  if (!Array.isArray(note.listContent)) return null

  const items = note.listContent
    .filter((entry) => !entry?.isChecked)
    .map((entry) => clean(entry?.text))
    .filter(Boolean)

  // Everything on it was ticked off, so there is nothing left to import.
  if (!items.length) return null

  return {
    key,
    title: clean(note.title) || fallbackTitle(note),
    items,
    // Shown so a short list is not mistaken for the whole note.
    droppedChecked: note.listContent.filter((entry) => entry?.isChecked).length,
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

  candidates.sort((a, b) => b.createdAt - a.createdAt)
  return candidates
}
