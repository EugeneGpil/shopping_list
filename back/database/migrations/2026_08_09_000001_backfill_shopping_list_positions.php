<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    /**
     * Lists created before `store` assigned a position all sit at 0, so the list page
     * ordered them arbitrarily and the order drifted between requests. Give every user's
     * rows a distinct position, preserving whatever order they have now.
     */
    public function up(): void
    {
        $userIds = DB::table('shopping_lists')->distinct()->pluck('user_id');

        foreach ($userIds as $userId) {
            $ids = DB::table('shopping_lists')
                ->where('user_id', $userId)
                ->orderBy('position')
                ->orderBy('id')
                ->pluck('id');

            foreach ($ids as $index => $id) {
                DB::table('shopping_lists')->where('id', $id)->update(['position' => $index]);
            }
        }
    }

    public function down(): void
    {
        // Positions are presentation only and the pre-backfill values were duplicates
        // carrying no ordering, so there is nothing meaningful to restore.
    }
};
