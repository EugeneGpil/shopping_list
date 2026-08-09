<?php

namespace App\Http\Requests\ShoppingList;

class StoreShoppingListRequest extends ShoppingListRequest
{
    /**
     * `store` is on the encrypted path too — a list created after encryption is switched on
     * arrives here already ciphertext — so it takes the same cap as `update`.
     *
     * @return array<string, string>
     */
    public function rules(): array
    {
        return ['name' => 'required|string|max:'.self::MAX_FIELD];
    }
}
