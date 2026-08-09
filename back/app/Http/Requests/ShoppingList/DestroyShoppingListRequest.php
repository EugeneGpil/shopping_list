<?php

namespace App\Http\Requests\ShoppingList;

class DestroyShoppingListRequest extends ShoppingListRequest
{
    /**
     * @return array<string, string>
     */
    public function rules(): array
    {
        return $this->listIdRule();
    }
}
