<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Deleting a list stops meaning "gone" and starts meaning "in the trash for 60 days"
 * (`config/trash.php`). One nullable timestamp is the whole of it: Eloquent's soft-delete
 * scope then keeps trashed lists out of the index, out of `show`, and out of every write —
 * so the read-only-ness of the trash is the default rather than something each endpoint has
 * to remember.
 *
 * The items are deliberately left alone. They have no `deleted_at` of their own and stay
 * attached to the list, which is what makes a restore free and a permanent delete a single
 * `forceDelete()` — the foreign key cascade takes them with it.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            // Indexed because every query in the app now filters on it: the index reads
            // `whereNull`, the trash page `whereNotNull`, and the daily prune compares it
            // against a cutoff.
            $table->softDeletes()->index();
        });
    }

    public function down(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->dropSoftDeletes();
        });
    }
};
