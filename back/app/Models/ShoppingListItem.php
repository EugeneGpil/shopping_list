<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

#[Fillable(['shopping_list_id', 'name', 'quantity', 'position', 'checked'])]
class ShoppingListItem extends Model
{
    protected function casts(): array
    {
        return [
            'checked' => 'boolean',
        ];
    }


    public function shoppingList(): BelongsTo
    {
        return $this->belongsTo(ShoppingList::class);
    }
}
