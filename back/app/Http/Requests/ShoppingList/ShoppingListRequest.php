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
     * Where the number comes from: 255 characters of plaintext is up to 1020 bytes in UTF-8,
     * plus a 12-byte IV and a 16-byte tag, base64'd — about 1400. 2048 clears that with room
     * for the encoding to change, and is still small enough that a runaway client cannot post
     * megabytes an item. The matching columns are `text` (migration 2026_08_09_000002), so
     * nothing truncates below this.
     */
    public const MAX_FIELD = 2048;

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
     * is shared by `show`, `update` and `destroy`.
     *
     * @return array<string, string>
     */
    protected function listIdRule(): array
    {
        return ['list_id' => 'required|integer'];
    }
}
