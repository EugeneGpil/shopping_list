<?php

namespace App\Console\Commands;

use App\Models\ShoppingList;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;

/**
 * Empty the trash of anything past its retention window.
 *
 * This is the other half of the soft delete: without it a deleted list is kept forever, which
 * is not what the app promises the user and not what the privacy policy's "How long" section
 * says happens at the end of the retention window. Modelled on `tokens:prune-stale` — same
 * refusal on a nonsense window, same dry run, same log line on an actual deletion — because
 * both are destructive jobs the scheduler runs unattended.
 */
class PruneTrashedLists extends Command
{
    protected $signature = 'lists:prune-trash
                            {--days= : Retention window in days, overriding config}
                            {--dry-run : Report what would be deleted without deleting it}';

    protected $description = 'Permanently delete shopping lists that have been in the trash beyond the retention window';

    public function handle(): int
    {
        $days = (int) ($this->option('days') ?? config('trash.retention_days'));

        // Zero would empty the trash the moment anything landed in it, taking away the whole
        // point of having one — so a mistyped config value is refused rather than obeyed.
        if ($days < 1) {
            $this->error("Refusing to run: retention window must be at least 1 day, got {$days}.");

            return self::FAILURE;
        }

        $cutoff = now()->subDays($days);

        $expired = ShoppingList::onlyTrashed()->where('deleted_at', '<', $cutoff);

        $count = $expired->count();

        if ($count === 0) {
            $this->info("Nothing in the trash since before {$cutoff->toDateTimeString()} ({$days} days).");

            return self::SUCCESS;
        }

        if ($this->option('dry-run')) {
            $this->info("Would delete {$count} list(s) trashed before {$cutoff->toDateTimeString()} ({$days} days).");

            return self::SUCCESS;
        }

        // `forceDelete` on the query, so the rows really go and the items go with them
        // through the foreign key cascade — a plain `delete()` here would only re-stamp
        // `deleted_at` and the trash would never empty.
        $deleted = $expired->forceDelete();

        // The scheduler discards command output, so a destructive run leaves a trace
        // somewhere durable. Only on an actual deletion — a daily no-op is not news.
        Log::info('Pruned trashed shopping lists', [
            'deleted' => $deleted,
            'trashed_before' => $cutoff->toDateTimeString(),
            'retention_days' => $days,
        ]);

        $this->info("Deleted {$deleted} list(s) trashed before {$cutoff->toDateTimeString()} ({$days} days).");

        return self::SUCCESS;
    }
}
