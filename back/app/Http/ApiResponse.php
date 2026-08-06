<?php

namespace App\Http;

use Illuminate\Http\JsonResponse;

class ApiResponse
{
    public static function success(mixed $data = null, string $message = '', int $status = 200): JsonResponse
    {
        return response()->json(['data' => $data, 'message' => $message, 'errors' => null], $status);
    }

    /**
     * `$data` is for failures that still carry something worth sending back: a 409 answers
     * with the copy that won, so the client can adopt it without a second request.
     */
    public static function error(string $message, int $status = 400, mixed $errors = null, mixed $data = null): JsonResponse
    {
        return response()->json(['data' => $data, 'message' => $message, 'errors' => $errors], $status);
    }
}