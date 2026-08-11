<?php

use App\Http\Controllers\Api\AccountController;
use App\Http\Controllers\Api\AuthController;
use App\Http\Controllers\Api\EncryptionController;
use App\Http\Controllers\Api\HealthController;
use App\Http\Controllers\Api\ShoppingListController;
use Illuminate\Support\Facades\Route;

// Probed by the deploy after the containers come up.
Route::get('health', HealthController::class);

Route::post('auth/firebase', [AuthController::class, 'firebase']);

Route::middleware('auth:sanctum')->group(function () {
    Route::get('auth/me', [AuthController::class, 'me']);
    Route::post('auth/logout', [AuthController::class, 'logout']);

    // Deletes the user and everything hanging off them. Required by Play's User Data policy
    // for any app with accounts, and irreversible — see the controller.
    Route::delete('account', [AccountController::class, 'destroy']);

    // Params passed via query string only (no path params).
    Route::get('shopping-lists', [ShoppingListController::class, 'index']);
    Route::post('shopping-lists', [ShoppingListController::class, 'store']);
    Route::put('shopping-lists/order', [ShoppingListController::class, 'reorder']);
    Route::get('shopping-list', [ShoppingListController::class, 'show']);
    Route::put('shopping-list', [ShoppingListController::class, 'update']);
    Route::delete('shopping-list', [ShoppingListController::class, 'destroy']);

    // The wrapped data keys, one per passkey. `PUT` is an upsert keyed on `credential_id`, so
    // registering the same passkey twice replaces its row rather than adding one.
    Route::get('encryption', [EncryptionController::class, 'index']);
    Route::put('encryption', [EncryptionController::class, 'store']);
    Route::delete('encryption', [EncryptionController::class, 'destroy']);
});
