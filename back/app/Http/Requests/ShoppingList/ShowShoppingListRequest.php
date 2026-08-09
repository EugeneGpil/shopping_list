<?php

namespace App\Http\Requests\ShoppingList;

class ShowShoppingListRequest extends ShoppingListRequest
{
    /**
     * @return array<string, string>
     */
    public function rules(): array
    {
        return $this->listIdRule();
    }
}
