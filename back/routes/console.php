<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

// Dispatched by the `scheduler` container (`php artisan schedule:work`), so this needs no
// crontab on the host. See docs/go_offline.md.
Schedule::command('tokens:prune-stale')->dailyAt('03:30');
