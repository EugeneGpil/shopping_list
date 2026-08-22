<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Trash retention window
    |--------------------------------------------------------------------------
    |
    | Deleting a list only sets `deleted_at` on it: it leaves the app at once but
    | stays recoverable from the Trash page for this many days. `lists:prune-trash`
    | is what finally removes it, and the same number is what the client is told so
    | that the countdown it shows and the deletion that happens agree.
    |
    | Lowering it shortens the window for lists already in the trash as well as new
    | ones — the cutoff is computed from `deleted_at` at prune time, not stored.
    |
    */

    'retention_days' => (int) env('TRASH_RETENTION_DAYS', 60),

];
