/**
 * A route param turned back into the type the collection is keyed by.
 *
 * Route params are strings while server ids are numbers, and lookups match on identity. Temp
 * ids are strings for their whole life, so only digits are converted.
 */
export default function _normalizeId(id) {
  return /^\d+$/.test(String(id)) ? Number(id) : String(id)
}
