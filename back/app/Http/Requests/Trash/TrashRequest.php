<?php

namespace App\Http\Requests\Trash;

use App\Http\Requests\ShoppingList\ShoppingListRequest;

/**
 * Shared ground for the three trash endpoints that name a list.
 *
 * Extends the shopping-list base rather than `FormRequest` directly: these are shopping-list
 * endpoints, they take `list_id` from the query string in exactly the same way, and the note
 * there about ownership living in the controller — so that somebody else's list is a 404 and
 * not a 403 that admits it exists — applies here word for word.
 */
abstract class TrashRequest extends ShoppingListRequest
{
    /**
     * @return array<string, string>
     */
    public function rules(): array
    {
        return $this->listIdRule();
    }
}
