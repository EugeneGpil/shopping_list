<?php

namespace App\Models;

use Database\Factories\UserFactory;
use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Foundation\Auth\User as Authenticatable;
use Illuminate\Notifications\Notifiable;
use Laravel\Sanctum\HasApiTokens;

#[Fillable(['firebase_uid', 'name', 'email', 'avatar'])]
class User extends Authenticatable
{
    /** @use HasFactory<UserFactory> */
    use HasApiTokens, HasFactory, Notifiable;

    public function shoppingLists(): HasMany
    {
        return $this->hasMany(ShoppingList::class);
    }

    /** One row per registered passkey, each holding the same data key wrapped differently. */
    public function encryptionKeys(): HasMany
    {
        return $this->hasMany(UserEncryption::class);
    }
}