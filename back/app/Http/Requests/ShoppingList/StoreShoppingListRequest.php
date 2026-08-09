<?php

namespace App\Http\Requests\ShoppingList;

class StoreShoppingListRequest extends ShoppingListRequest
{
    /**
     * `store` is on the encrypted path too — a list created after encryption is switched on
     * arrives here already ciphertext — so it takes the same cap as `update`, and has to be
     * able to say that the name it carries is encrypted.
     *
     * Without `encrypted` here, every list created after setup would be born mislabelled as
     * plaintext and would need a second request to correct itself.
     *
     * @return array<string, string>
     */
    public function rules(): array
    {
        return [
            'name' => 'required|string|max:'.self::MAX_FIELD,
            'encrypted' => 'sometimes|boolean',
        ];
    }
}
