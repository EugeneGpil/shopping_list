<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use App\Http\Requests\Auth\FirebaseLoginRequest;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Kreait\Firebase\Contract\Auth;
use Kreait\Firebase\Exception\Auth\FailedToVerifyToken;

class AuthController extends Controller
{
    public function __construct(private readonly Auth $auth) {}

    public function firebase(FirebaseLoginRequest $request): JsonResponse
    {
        try {
            $verified = $this->auth->verifyIdToken($request->validated('id_token'));
        } catch (FailedToVerifyToken) {
            return ApiResponse::error('Invalid token', 401);
        }

        $claims = $verified->claims();
        $firebaseUid = $claims->get('sub');
        $name = $claims->get('name', '');
        $email = $claims->get('email');
        $avatar = $claims->get('picture');

        $user = User::updateOrCreate(
            ['firebase_uid' => $firebaseUid],
            ['name' => $name, 'email' => $email, 'avatar' => $avatar],
        );

        $token = $user->createToken('mobile')->plainTextToken;

        return ApiResponse::success(['token' => $token, 'user' => $user]);
    }

    public function me(Request $request): JsonResponse
    {
        return ApiResponse::success($request->user());
    }

    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()->delete();

        return ApiResponse::success(message: 'Logged out');
    }
}
