<?php

namespace App\Console\Commands;

use Illuminate\Console\Command;
use Illuminate\Support\Facades\Log;
use Laravel\Sanctum\Sanctum;

class PruneStaleTokens extends Command
{
    protected $signature = 'tokens:prune-stale
                            {--days= : Inactivity window in days, overriding config}
                            {--dry-run : Report what would be deleted without deleting it}';

    protected $description = 'Delete personal access tokens that have gone unused for the configured window';

    public function handle(): int
    {
        $days = (int) ($this->option('days') ?? config('tokens.inactivity_days'));

        // A zero or negative window would delete every token and sign everyone out, so
        // refuse rather than trust a mistyped config value.
        if ($days < 1) {
            $this->error("Refusing to run: inactivity window must be at least 1 day, got {$days}.");

            return self::FAILURE;
        }

        $cutoff = now()->subDays($days);

        // A token that was never used has no last_used_at, so fall back to when it was
        // issued — otherwise those rows would live forever.
        $stale = Sanctum::personalAccessTokenModel()::query()
            ->whereRaw('COALESCE(last_used_at, created_at) < ?', [$cutoff]);

        $count = $stale->count();

        if ($count === 0) {
            $this->info("No tokens unused since {$cutoff->toDateTimeString()} ({$days} days).");

            return self::SUCCESS;
        }

        if ($this->option('dry-run')) {
            $this->info("Would delete {$count} token(s) unused since {$cutoff->toDateTimeString()} ({$days} days).");

            return self::SUCCESS;
        }

        $deleted = $stale->delete();

        // The scheduler discards command output, so leave a trace of a destructive run
        // somewhere durable. Only on an actual deletion — a daily no-op is not news.
        Log::info('Pruned stale access tokens', [
            'deleted' => $deleted,
            'unused_since' => $cutoff->toDateTimeString(),
            'inactivity_days' => $days,
        ]);

        $this->info("Deleted {$deleted} token(s) unused since {$cutoff->toDateTimeString()} ({$days} days).");

        return self::SUCCESS;
    }
}
