<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * A counter bumped on every write to a list's contents, so an offline client can say which
 * version its pending edit was based on.
 *
 * `updated_at` cannot do this job: Laravel's `timestamps()` has one-second resolution, so
 * two writes in the same second are indistinguishable — and two devices reconnecting
 * together is exactly when that happens. A counter is monotonic and clock-independent.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->unsignedBigInteger('version')->default(0);
        });
    }

    public function down(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->dropColumn('version');
        });
    }
};
