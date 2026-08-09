<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Room for ciphertext in the three columns that hold user content.
 *
 * Base64 of AES-GCM over a 255-character name is comfortably past 255 bytes — the IV and
 * tag before base64 expansion see to that — so `varchar(255)` would silently truncate on
 * write and the plaintext would be unrecoverable. This has to be in place before any client
 * can send an encrypted field; see `docs/go_encrypted.md` §5.
 *
 * `text` is not a compromise here: on Postgres `varchar(n)` and `text` are the same storage
 * with a length check bolted on, so nothing is paid for dropping the limit. What is dropped
 * with it is a length guard the app was leaning on, which is why the request-size cap in
 * ShoppingListController stays and stops being a content rule.
 *
 * Widening is not destructive and every existing value fits, so this runs on the live
 * database without a backfill.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->text('name')->change();
        });

        Schema::table('shopping_list_items', function (Blueprint $table) {
            $table->text('name')->change();
            // `change()` rebuilds the column from what is stated here and nothing else, so
            // omitting `nullable()` would quietly make quantity required.
            $table->text('quantity')->nullable()->change();
        });
    }

    public function down(): void
    {
        // Narrowing back truncates anything longer than 255, which after an encryption pass
        // is every row. Rolling back the schema must not be a way to destroy data, so the
        // columns stay wide — they cost nothing, and `up()` is safe to re-run.
    }
};
