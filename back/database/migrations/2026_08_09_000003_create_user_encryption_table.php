<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Where each passkey's wrapped copy of the data key lives.
 *
 * **One row per credential, not per user** (`docs/go_encrypted.md` §2a). That is the whole
 * recovery story: the same DEK is wrapped separately under every registered passkey's PRF
 * output, so a second passkey opens the same data and losing one device is not fatal. A row
 * per user would make the first passkey the only passkey.
 *
 * Every column here is opaque to the server. `wrapped_key` is the DEK sealed with AES-GCM
 * under a key the server never sees, `hkdf_salt` is public input to that derivation and is
 * useless on its own, and nothing in this table can be used to read a single list name. That
 * is the point: a database dump yields these rows and gets no closer to the data.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_encryption', function (Blueprint $table) {
            $table->id();
            $table->foreignId('user_id')->constrained()->cascadeOnDelete();

            // WebAuthn allows a credential id up to 1023 bytes, so this is `text` rather than
            // a guess at how long base64url of one runs.
            $table->text('credential_id');

            // Shown when picking which device to remove. The server never reads it, so the
            // client is free to send a plain "Pixel 8" or ciphertext — but nothing in the
            // unlock path may depend on its contents, because a locked client cannot read it.
            $table->text('label')->nullable();

            $table->text('hkdf_salt');
            $table->text('wrapped_key');

            // Rows are written once and deleted; there is nothing to update, so there is no
            // `updated_at` for the model to maintain (see `UserEncryption::UPDATED_AT`).
            $table->timestamp('created_at')->nullable();

            // A credential registers once per user. Without this, a retried `PUT` could leave
            // two wrapped copies for one passkey and "delete the last row" could not be
            // trusted to mean what it says.
            $table->unique(['user_id', 'credential_id']);
        });
    }

    public function down(): void
    {
        // Dropping this table destroys every wrapped copy of the data key, which makes the
        // encrypted lists permanently unreadable — no reversal is possible from the server
        // side. Kept explicit rather than absent so nobody adds a convenient `dropIfExists`
        // without meeting that sentence first.
        throw new RuntimeException(
            'Refusing to drop user_encryption: it holds the only wrapped copies of each '
            .'user data key, and the encrypted lists cannot be recovered without them.'
        );
    }
};
