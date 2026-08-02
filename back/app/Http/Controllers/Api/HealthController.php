<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\DB;

class HealthController extends Controller
{
    /**
     * Probed by the deploy after the containers come up.
     *
     * This deliberately does more than open a connection. A misconfigured
     * release still connects — Laravel falls back to the sqlite driver when it
     * cannot read .env — and an "is the database reachable" check reports green
     * while every real request 500s. So: assert the expected driver, and read a
     * table that only exists in the real schema.
     */
    public function __invoke(): JsonResponse
    {
        $expected = config('database.default');

        try {
            $driver = DB::connection()->getDriverName();

            if ($driver !== 'pgsql') {
                return response()->json([
                    'status' => 'error',
                    'reason' => "unexpected database driver [{$driver}]",
                ], 503);
            }

            DB::table('shopping_lists')->count();
        } catch (\Throwable $e) {
            return response()->json([
                'status' => 'error',
                'reason' => 'database unavailable',
            ], 503);
        }

        return response()->json([
            'status' => 'ok',
            'connection' => $expected,
        ]);
    }
}
