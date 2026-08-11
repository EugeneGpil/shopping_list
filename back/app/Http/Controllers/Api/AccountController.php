<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Kreait\Firebase\Contract\Auth;
use Kreait\Firebase\Exception\Auth\UserNotFound;
use Throwable;

/**
 * Deleting the whole account — the one operation the app offers that nothing can undo.
 *
 * Play's User Data policy requires an app that creates accounts to offer deletion from
 * inside the app as well as from a web page (`docs/play_console.md`), and the privacy policy
 * promises what this removes. Those two are the reason it exists; the shape below is what
 * makes it honest.
 *
 * There is no re-authentication step, deliberately. It would look like security and buy
 * none: the same bearer token can already delete every list one at a time, so anything that
 * could call this could reach the same end state without it. The protection that matters is
 * the confirmation in the UI, in front of the person who owns the data.
 */
class AccountController extends Controller
{
    public function __construct(private readonly Auth $auth) {}

    /**
     * **Order is load-bearing: the database first, Firebase second.**
     *
     * Both can fail, and the two orders fail differently. This way round, a Firebase failure
     * leaves an identity record with no data behind it — signing in again gets a new, empty
     * account, and nothing private survives. The other way round, a database failure after
     * the identity is gone leaves the *lists* orphaned under a `firebase_uid` nobody can ever
     * authenticate as again: unreachable, undeleteable through the app, and still on disk.
     * Losing the identity is recoverable; losing the ability to reach the data is not.
     *
     * So the Firebase call is best-effort and logged rather than fatal. Nothing is reported
     * to the caller, because from their side the account is gone either way — what is left
     * is an auth record that needs sweeping by hand, and the log is where that is noticed.
     */
    public function destroy(Request $request): JsonResponse
    {
        $user = $request->user();
        $firebaseUid = $user->firebase_uid;

        DB::transaction(function () use ($user) {
            // Sanctum's tokens hang off a polymorphic relation with no foreign key, so the
            // cascade below does not reach them and they would outlive the row they
            // authenticate. Lists (and through them items) and the wrapped encryption keys
            // are all `cascadeOnDelete` in their migrations.
            $user->tokens()->delete();
            $user->delete();
        });

        try {
            $this->auth->deleteUser($firebaseUid);
        } catch (UserNotFound) {
            // Already gone — deleted from the Firebase console, or a retry of this request
            // after the first one got this far. Nothing to do and nothing worth logging.
        } catch (Throwable $e) {
            Log::warning('Account deleted locally but the Firebase user remains', [
                'firebase_uid' => $firebaseUid,
                'exception' => $e->getMessage(),
            ]);
        }

        return ApiResponse::success(message: 'Account deleted');
    }
}
