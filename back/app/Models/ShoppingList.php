<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Database\Eloquent\SoftDeletes;

#[Fillable(['user_id', 'name', 'position', 'show_quantity', 'show_checkbox', 'encrypted'])]
class ShoppingList extends Model
{
    /**
     * Deleting a list trashes it for `config('trash.retention_days')` instead of removing it
     * — see the `deleted_at` migration. Everything that reads or writes a list goes through
     * this model, so the trait is what makes "a trashed list is not editable" true everywhere
     * at once: the default scope hides it, and the three places that need a trashed row ask for
     * it explicitly: `TrashController` (`onlyTrashed`), `EncryptionController::destroy`
     * (`withTrashed`) and `lists:prune-trash`.
     */
    use SoftDeletes;

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
            // Whether the items are ciphertext; titles are never encrypted (§1). The server
            // only carries this flag around; it is the client that acts on it.
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
