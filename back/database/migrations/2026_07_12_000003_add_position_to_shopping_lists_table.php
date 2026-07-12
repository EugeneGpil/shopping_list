<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->unsignedInteger('position')->default(0);
        });

        // Backfill: preserve the current "newest first" ordering per user.
        $lists = DB::table('shopping_lists')
            ->orderBy('user_id')
            ->orderByDesc('created_at')
            ->get(['id', 'user_id']);

        $positionByUser = [];
        foreach ($lists as $list) {
            $position = $positionByUser[$list->user_id] ?? 0;
            DB::table('shopping_lists')->where('id', $list->id)->update(['position' => $position]);
            $positionByUser[$list->user_id] = $position + 1;
        }
    }

    public function down(): void
    {
        Schema::table('shopping_lists', function (Blueprint $table) {
            $table->dropColumn('position');
        });
    }
};
