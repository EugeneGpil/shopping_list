<?php

namespace Tests\Feature;

use App\Models\ShoppingList;
use App\Models\ShoppingListItem;
use App\Models\User;
use App\Models\UserEncryption;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Kreait\Firebase\Contract\Auth;
use Kreait\Firebase\Exception\Auth\UserNotFound;
use Laravel\Sanctum\Sanctum;
use Mockery;
use RuntimeException;
use Tests\TestCase;

/**
 * `DELETE /api/account` — the in-app deletion path Play's User Data policy requires, and the
 * one the privacy policy promises.
 *
 * What is pinned here is mostly "nothing survives": the cascades are declared in migrations
 * rather than in code, so a test is the only thing standing between a schema edit and rows
 * that outlive the account they belong to. The Sanctum tokens are the case worth naming — they
 * hang off a polymorphic relation with no foreign key, so no cascade reaches them and only the
 * explicit delete in the controller does.
 *
 * The other half is the failure ordering: Firebase going down must not stop the data being
 * deleted, because the alternative — an account nobody can sign into with its lists still on
 * disk — is worse than an orphaned auth record.
 */
class AccountDeletionTest extends TestCase
{
    use RefreshDatabase;

    private function actingUser(string $firebaseUid = 'uid-delete-me'): User
    {
        $user = User::create([
            'firebase_uid' => $firebaseUid,
            'name' => 'Test User',
            'email' => uniqid().'@example.test',
        ]);
        Sanctum::actingAs($user);

        return $user;
    }

    /** The Firebase Admin SDK is never reachable from a test, so the contract is swapped out. */
    private function firebaseExpecting(string $uid): void
    {
        $auth = Mockery::mock(Auth::class);
        $auth->shouldReceive('deleteUser')->once()->with($uid);
        $this->instance(Auth::class, $auth);
    }

    private function firebaseThrowing(\Throwable $e): void
    {
        $auth = Mockery::mock(Auth::class);
        $auth->shouldReceive('deleteUser')->once()->andThrow($e);
        $this->instance(Auth::class, $auth);
    }

    public function test_deleting_the_account_removes_the_user(): void
    {
        $user = $this->actingUser();
        $this->firebaseExpecting('uid-delete-me');

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseMissing('users', ['id' => $user->id]);
    }

    public function test_deleting_the_account_removes_the_lists_and_their_items(): void
    {
        $user = $this->actingUser();
        $this->firebaseExpecting('uid-delete-me');

        $list = ShoppingList::create(['user_id' => $user->id, 'name' => 'Groceries']);
        ShoppingListItem::create(['shopping_list_id' => $list->id, 'name' => 'Bread']);

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseMissing('shopping_lists', ['id' => $list->id]);
        $this->assertDatabaseCount('shopping_list_items', 0);
    }

    public function test_deleting_the_account_removes_the_wrapped_encryption_keys(): void
    {
        $user = $this->actingUser();
        $this->firebaseExpecting('uid-delete-me');

        UserEncryption::create([
            'user_id' => $user->id,
            'credential_id' => 'cred-a',
            'hkdf_salt' => base64_encode(str_repeat('s', 32)),
            'wrapped_key' => base64_encode(str_repeat('w', 60)),
        ]);

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseCount('user_encryption', 0);
    }

    /**
     * No foreign key reaches these, so nothing but the controller deletes them. A leftover row
     * is not exploitable — the token it authenticates has no user to load — but it is the
     * definition of data that outlives its deletion request.
     */
    public function test_deleting_the_account_removes_its_api_tokens(): void
    {
        $user = $this->actingUser();
        $this->firebaseExpecting('uid-delete-me');
        $user->createToken('mobile');

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseCount('personal_access_tokens', 0);
    }

    /** Somebody else's account is not touched by mine going away. */
    public function test_deleting_one_account_leaves_another_alone(): void
    {
        $other = User::create([
            'firebase_uid' => 'uid-someone-else',
            'name' => 'Other',
            'email' => 'other@example.test',
        ]);
        $otherList = ShoppingList::create(['user_id' => $other->id, 'name' => 'Theirs']);

        $this->actingUser();
        $this->firebaseExpecting('uid-delete-me');

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseHas('users', ['id' => $other->id]);
        $this->assertDatabaseHas('shopping_lists', ['id' => $otherList->id]);
    }

    /**
     * The identity is deleted from Firebase too, or the app has only forgotten the person
     * rather than deleted them — and the privacy policy says the Google account details go.
     */
    public function test_the_firebase_user_is_deleted_as_well(): void
    {
        $this->actingUser('uid-firebase-123');
        $this->firebaseExpecting('uid-firebase-123');

        $this->deleteJson('/api/account')->assertOk();
    }

    /** Already gone is a success, not an error — a retried request must not fail. */
    public function test_a_missing_firebase_user_is_not_an_error(): void
    {
        $user = $this->actingUser();
        $this->firebaseThrowing(new UserNotFound('not found'));

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseMissing('users', ['id' => $user->id]);
    }

    /**
     * The ordering decision, stated as a test: Firebase failing does not leave the data
     * behind. Reversing the two calls in the controller breaks this and nothing else, which
     * is exactly why it is here.
     */
    public function test_a_firebase_failure_still_deletes_the_local_data(): void
    {
        $user = $this->actingUser();
        $this->firebaseThrowing(new RuntimeException('Firebase is down'));
        $list = ShoppingList::create(['user_id' => $user->id, 'name' => 'Groceries']);

        $this->deleteJson('/api/account')->assertOk();

        $this->assertDatabaseMissing('users', ['id' => $user->id]);
        $this->assertDatabaseMissing('shopping_lists', ['id' => $list->id]);
    }

    public function test_it_requires_authentication(): void
    {
        $this->deleteJson('/api/account')->assertUnauthorized();
    }
}
