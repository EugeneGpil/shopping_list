<?php

namespace App\Http\Requests\ShoppingList;

class UpdateShoppingListRequest extends ShoppingListRequest
{
    /**
     * @return array<string, string>
     */
    public function rules(): array
    {
        return [
            ...$this->listIdRule(),
            'name' => 'sometimes|required|string|max:'.self::MAX_FIELD,
            'show_quantity' => 'sometimes|boolean',
            'show_checkbox' => 'sometimes|boolean',
            'items' => 'sometimes|array',
            'items.*.name' => 'nullable|string|max:'.self::MAX_FIELD,
            'items.*.quantity' => 'nullable|string|max:'.self::MAX_FIELD,
            'items.*.checked' => 'nullable|boolean',
            // The `version` the client's copy was based on. Optional: a client that does not
            // track versions keeps the old last-write-wins behaviour.
            'base_version' => 'sometimes|nullable|integer',
        ];
    }
}
