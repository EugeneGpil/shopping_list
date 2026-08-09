<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One passkey's wrapped copy of a user's data key (`docs/go_encrypted.md` §2a).
 *
 * Nothing here is readable by the server, and nothing here should ever grow a cast, an
 * accessor or a `Str::` call: the moment the server starts interpreting these columns it is
 * doing something the design says it cannot do.
 */
#[Fillable(['user_id', 'credential_id', 'label', 'hkdf_salt', 'wrapped_key'])]
class UserEncryption extends Model
{
    protected $table = 'user_encryption';

    /** Rows are written once and deleted, so there is no `updated_at` column to maintain. */
    public const UPDATED_AT = null;

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }
}
