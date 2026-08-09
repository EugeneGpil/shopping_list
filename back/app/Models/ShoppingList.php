<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

#[Fillable(['user_id', 'name', 'position', 'show_quantity', 'show_checkbox', 'encrypted'])]
class ShoppingList extends Model
{
    /**
     * `default(false)` in the migration only applies inside the database, so a model that has
     * just been `create()`d reports `encrypted` as `null` until it is read back. Stating the
     * default here as well means a freshly created list says "plaintext" straight away, rather
     * than "unknown" — and nothing downstream has to treat `null` as a third case.
     *
     * @var array<string, mixed>
     */
    protected $attributes = ['encrypted' => false];

    protected function casts(): array
    {
        return [
            'show_quantity' => 'boolean',
            'show_checkbox' => 'boolean',
            // Whether `name` and the items are ciphertext. The server only carries this flag
            // around; it is the client that acts on it.
            'encrypted' => 'boolean',
        ];
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function items(): HasMany
    {
        return $this->hasMany(ShoppingListItem::class)->orderBy('position');
    }
}
