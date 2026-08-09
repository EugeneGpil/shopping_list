<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Whether this list's `name` and items are ciphertext.
 *
 * Load-bearing rather than convenience (`docs/go_encrypted.md` §5). Switching encryption on
 * rewrites the lists one at a time, so a connection dropping halfway leaves some rows
 * encrypted and some not. Without a per-list flag that state cannot be read back: nothing
 * distinguishes ciphertext from a list a user happened to name `V2Vla2VuZA==`, and guessing
 * wrong means showing base64 as a shopping list or trying to decrypt plain text. With the
 * flag, a half-finished enable is a resumable job — take the rows where it is still false.
 *
 * Default false, so every existing row is correctly described as plaintext without a
 * backfill.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->boolean('encrypted')->default(false);
        });
    }

    public function down(): void
    {
        // While every list is plaintext the column carries no information and dropping it is
        // free. Once any row is encrypted the column is the only record of which rows are
        // ciphertext, and dropping it makes those lists unreadable as surely as losing a key
        // would — so that case refuses instead.
        if (DB::table('shopping_lists')->where('encrypted', true)->exists()) {
            throw new RuntimeException(
                'Refusing to drop shopping_lists.encrypted: some lists are encrypted and this '
                .'column is the only record of which. Turn encryption off in the app first.'
            );
        }

        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->dropColumn('encrypted');
        });
    }
};
