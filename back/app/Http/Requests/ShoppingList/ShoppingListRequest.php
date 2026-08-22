<?php

namespace App\Http\Requests\ShoppingList;

use Illuminate\Foundation\Http\FormRequest;

/**
 * Shared ground for the shopping-list endpoints' request rules.
 *
 * Exists for two things only: the field-size cap, which `store` and `update` must agree on,
 * and the note below about where authorization lives.
 */
abstract class ShoppingListRequest extends FormRequest
{
    /**
     * The cap on any field holding user content.
     *
     * This is **not** a content rule. Once a client encrypts (`docs/go_encrypted.md`), what
     * arrives here is base64 of AES-GCM and the server cannot say anything about the text
     * inside it — not its length, not whether it is text at all. What is left is a guard on
     * request size, and that is all this is now.
     *
     * **One cap has to cover both forms of the same item, and the first version of it did not.**
     * The number was derived from plaintext alone — 255 characters, up to 1020 bytes in UTF-8,
     * plus the IV and tag, base64'd, about 1400 — and then set to 2048, which is the *plaintext*
     * budget as well, since the same rule sees an unencrypted list. So an item that saved in the
     * clear was refused once its list was locked: 1800 characters is 1800 bytes here and 2440
     * once sealed, a 422 with "must not be greater than 2048 characters" about text that is well
     * under it, and the client can only leave the edit pending. The effective ceiling on a locked
     * list was 1508 characters of one-byte text — nothing states that, so nothing could have
     * caught it.
     *
     * Symmetry is the property, so the cap is now derived from the widest ciphertext an accepted
     * plaintext can turn into. Taking the old 2048 as the plaintext budget:
     *
     *   2048 characters × 4 bytes  = 8192   worst-case UTF-8; Laravel's `max` counts characters,
     *                                       and a codepoint is at most four bytes (emoji are)
     *   + 12 IV + 16 GCM tag       = 8220   what `encryptField` concatenates before encoding
     *   base64: 8220 / 3 × 4       = 10960  exact, no padding
     *
     * So 10960 is the worst case rather than a margin over it, and every shorter alphabet — Latin
     * at one byte, Cyrillic and Thai at two and three — clears it with room to spare. Still small
     * enough that a runaway client cannot post megabytes an item, which is the guard's whole job.
     * The matching columns are `text` (migration 2026_08_09_000002), so nothing truncates below
     * this.
     *
     * What it does **not** buy is symmetry at the very top, and nothing here can: `max` counts
     * characters while a sealed field spends bytes, so this same rule admits 10960 *characters* of
     * plaintext — more bytes than one sealed field can carry for anything wider than Latin
     * (Cyrillic over 4096 characters, emoji over 2048). By the time such an item comes back sealed
     * it is base64 this class is not allowed to understand, so the client closes the gap where the
     * row is still known: `MAX_SEALED_BYTES` in `front/src/stores/shoppingLists/encryption.js` is
     * derived from this constant, and `payloadOf` refuses that row and says which one it is rather
     * than earning a 422 about a length nothing on screen shows (`docs/go_encrypted.md` §5).
     * Pinned by `ShoppingListFieldSizeTest`, which is also there because a number like this
     * invites tidying.
     */
    public const MAX_FIELD = 10960;

    /**
     * Authorization deliberately does not happen here.
     *
     * `auth:sanctum` on the route settles whether there is a user at all. Ownership stays in
     * the controller, where the query is scoped to `$request->user()->shoppingLists()` and a
     * list belonging to someone else comes back as a 404. Moving that check here would make
     * it a 403, which tells a stranger the list exists — a worse answer than "no such list".
     */
    public function authorize(): bool
    {
        return true;
    }

    /**
     * Which list, from the query string.
     *
     * Every endpoint that names a list takes it this way rather than in the path, so the rule
     * is shared by `show`, `update` and `destroy`, and by the three `Trash/*` requests — see
     * `TrashRequest`.
     *
     * @return array<string, string>
     */
    protected function listIdRule(): array
    {
        return ['list_id' => 'required|integer'];
    }
}
