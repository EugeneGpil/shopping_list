<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use App\Http\Requests\Encryption\DestroyEncryptionKeyRequest;
use App\Http\Requests\Encryption\StoreEncryptionKeyRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The wrapped data keys, one per registered passkey (`docs/go_encrypted.md` §5, §6).
 *
 * This controller moves blobs it cannot read. It deliberately knows nothing about WebAuthn,
 * HKDF or AES — the client derives, wraps and unwraps; the server stores. The only rule it
 * enforces is the one the client cannot enforce for itself: never leave a user with zero ways
 * to open their own data.
 */
class EncryptionController extends Controller
{
    /**
     * Every wrapped copy this user has, for the unlock screen to choose from.
     *
     * An empty array is the honest answer for "encryption is not set up", so this is also how
     * a client asks whether it is.
     */
    public function index(Request $request): JsonResponse
    {
        $keys = $request->user()->encryptionKeys()
            ->orderBy('id')
            ->get(['credential_id', 'label', 'hkdf_salt', 'wrapped_key', 'created_at']);

        return ApiResponse::success($keys);
    }

    /**
     * Register or replace one credential's wrapped copy.
     *
     * Keyed on the credential so a retry is idempotent rather than leaving two rows for one
     * passkey. Replacing is legitimate — a client that re-derives with a fresh salt sends the
     * same DEK wrapped differently — and the server cannot tell the difference anyway: it
     * cannot check that the blob wraps *the same* key as the other rows. That invariant is the
     * client's to keep, and getting it wrong shows up as a passkey that unwraps to a key which
     * fails to decrypt any list, not as anything this endpoint could have caught.
     */
    public function store(StoreEncryptionKeyRequest $request): JsonResponse
    {
        $data = $request->validated();

        $key = $request->user()->encryptionKeys()->updateOrCreate(
            ['credential_id' => $data['credential_id']],
            [
                'label' => $data['label'] ?? null,
                'hkdf_salt' => $data['hkdf_salt'],
                'wrapped_key' => $data['wrapped_key'],
            ],
        );

        return ApiResponse::success(
            $key->only(['credential_id', 'label', 'hkdf_salt', 'wrapped_key', 'created_at']),
            status: $key->wasRecentlyCreated ? 201 : 200,
        );
    }

    /**
     * Forget a credential — the "remove a lost device" path.
     *
     * The last remaining row is refused **while any list is still encrypted**. Deleting it then
     * would not lose the lists but would lock them away with no way back, since the server holds
     * no other copy of the key and cannot be made to produce one.
     *
     * With nothing encrypted there is nothing to lock away, so it is allowed: encryption is per
     * list (`docs/go_encrypted.md` §1), and a key that opens none of them is protecting nothing.
     * Refusing there would leave an account permanently carrying a passkey it has no use for.
     *
     * This is the one thing about the content the server can honestly check — `encrypted` is its
     * own boolean column, not something it has to read the ciphertext to know.
     *
     * **`withTrashed` is load-bearing.** A deleted list is kept for `config('trash.retention_days')`
     * and can be restored at any point in that window, so it is still data the user can ask for
     * back — and the passkey is still the only way into it. Counting only the live lists, as this
     * did when `delete` meant `delete`, would let the last key go while an encrypted list sat in
     * the trash: the restore would then succeed and hand back a list nothing on earth can open.
     */
    public function destroy(DestroyEncryptionKeyRequest $request): JsonResponse
    {
        $user = $request->user();

        // Found first, counted second: a credential id that is not this user's is a 404
        // whatever the count is, and answering "that is your only passkey" to a request naming
        // a credential the user does not have would be both wrong and confusing.
        $key = $user->encryptionKeys()
            ->where('credential_id', $request->validated('credential_id'))
            ->firstOrFail();

        $isLast = $user->encryptionKeys()->count() <= 1;

        if ($isLast && $user->shoppingLists()->withTrashed()->where('encrypted', true)->exists()) {
            return ApiResponse::error(
                'This is the only passkey that can open your encrypted lists. '
                .'Register another one first, or unlock those lists — including any in the '
                .'trash, which have to be restored or deleted for good first.',
                409,
            );
        }

        $key->delete();

        return ApiResponse::success(message: 'Removed');
    }
}
