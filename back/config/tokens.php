<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Personal access token inactivity window
    |--------------------------------------------------------------------------
    |
    | Sanctum tokens are issued without an expiry so that an offline client keeps
    | working indefinitely (see docs/go_offline.md). `tokens:prune-stale` deletes
    | the ones that have gone unused for longer than this, which bounds how long
    | a leaked token stays valid without logging active users out.
    |
    | Pruning is close to invisible: a client that still holds its Firebase
    | session silently mints a replacement token on its next online boot.
    |
    */

    'inactivity_days' => (int) env('TOKEN_INACTIVITY_DAYS', 90),

];
