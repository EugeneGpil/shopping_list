<?php

namespace App\Http\Requests\ShoppingList;

class ReorderShoppingListsRequest extends ShoppingListRequest
{
    /**
     * Ids only — the controller drops any that are not the caller's, so an id from another
     * user is ignored rather than refused.
     *
     * @return array<string, string>
     */
    public function rules(): array
    {
        return [
            'ids' => 'required|array',
            'ids.*' => 'integer',
        ];
    }
}
