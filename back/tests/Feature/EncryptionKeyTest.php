<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\UserEncryption;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The contract of the wrapped-key endpoints (`docs/go_encrypted.md` §5, §6).
 *
 * Two properties here are load-bearing rather than nice to have: **a credential registers
 * once** (two rows for one passkey would make "the last remaining row" meaningless), and **the
 * last row cannot be deleted while a list is still encrypted** (doing so locks a user out of
 * their own lists permanently, with no server-side way back). Both are pinned below, along with
 * the other half of the second one — with nothing encrypted, that last row *can* go, because a
 * key that opens nothing is not protecting anything.
 */
class EncryptionKeyTest extends TestCase
{
    use RefreshDatabase;

    private function actingUser(): User
    {
        $user = User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Test User',
            'email' => uniqid().'@example.test',
        ]);
        Sanctum::actingAs($user);

        return $user;
    }

    /**
     * @return array<string, string>
     */
    private function payload(string $credentialId = 'cred-a'): array
    {
        return [
            'credential_id' => $credentialId,
            'label' => 'Pixel 8',
            'hkdf_salt' => base64_encode(str_repeat('s', 32)),
            'wrapped_key' => base64_encode(str_repeat('w', 60)),
        ];
    }

    public function test_registering_a_credential_stores_its_wrapped_key(): void
    {
        $user = $this->actingUser();

        $response = $this->putJson('/api/encryption', $this->payload());

        $response->assertCreated();
        $this->assertSame(1, $user->encryptionKeys()->count());
        $stored = $user->encryptionKeys()->firstOrFail();
        $this->assertSame('cred-a', $stored->credential_id);
        $this->assertSame($this->payload()['wrapped_key'], $stored->wrapped_key);
    }

    public function test_a_wrapped_key_is_required(): void
    {
        $this->actingUser();

        $payload = $this->payload();
        unset($payload['wrapped_key']);

        $this->putJson('/api/encryption', $payload)->assertStatus(422);
    }

    public function test_re_registering_the_same_credential_replaces_its_row(): void
    {
        $user = $this->actingUser();

        $this->putJson('/api/encryption', $this->payload())->assertCreated();
        $again = $this->putJson('/api/encryption', [
            ...$this->payload(),
            'wrapped_key' => base64_encode(str_repeat('x', 60)),
        ]);

        // 200 rather than 201: nothing new was registered, the same passkey re-wrapped.
        $again->assertOk();
        $this->assertSame(1, $user->encryptionKeys()->count());
        $this->assertSame(
            base64_encode(str_repeat('x', 60)),
            $user->encryptionKeys()->firstOrFail()->wrapped_key,
        );
    }

    public function test_a_second_passkey_wraps_the_same_key_alongside_the_first(): void
    {
        $user = $this->actingUser();

        $this->putJson('/api/encryption', $this->payload('cred-a'))->assertCreated();
        $this->putJson('/api/encryption', $this->payload('cred-b'))->assertCreated();

        // The recovery story in one assertion: two credentials, two wrapped copies, one key.
        $this->assertSame(2, $user->encryptionKeys()->count());
    }

    public function test_index_returns_only_this_users_keys(): void
    {
        $other = User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Other',
            'email' => uniqid().'@example.test',
        ]);
        UserEncryption::create([
            'user_id' => $other->id,
            'credential_id' => 'theirs',
            'hkdf_salt' => 'salt',
            'wrapped_key' => 'key',
        ]);

        $this->actingUser();
        $this->putJson('/api/encryption', $this->payload('mine'))->assertCreated();

        $response = $this->getJson('/api/encryption');

        $response->assertOk();
        $credentialIds = array_column($response->json('data'), 'credential_id');
        $this->assertSame(['mine'], $credentialIds);
    }

    public function test_a_lost_device_can_be_removed_while_another_remains(): void
    {
        $user = $this->actingUser();
        $this->putJson('/api/encryption', $this->payload('cred-a'))->assertCreated();
        $this->putJson('/api/encryption', $this->payload('cred-b'))->assertCreated();

        $this->deleteJson('/api/encryption?credential_id=cred-a')->assertOk();

        $this->assertSame(['cred-b'], $user->encryptionKeys()->pluck('credential_id')->all());
    }

    public function test_the_last_credential_cannot_be_removed_while_a_list_is_encrypted(): void
    {
        $user = $this->actingUser();
        $this->putJson('/api/encryption', $this->payload('cred-a'))->assertCreated();
        $user->shoppingLists()->create(['name' => 'Private', 'encrypted' => true]);

        $response = $this->deleteJson('/api/encryption?credential_id=cred-a');

        $response->assertStatus(409);
        // The refusal has to actually keep the row — a 409 with the row gone would be worse
        // than no check at all, because the client would report a failure that did happen.
        $this->assertSame(1, $user->encryptionKeys()->count());
    }

    public function test_the_last_credential_can_be_removed_when_nothing_is_encrypted(): void
    {
        $user = $this->actingUser();
        $this->putJson('/api/encryption', $this->payload('cred-a'))->assertCreated();
        // Lists, but none of them locked — which is every account that set a key up and then
        // never used it, or unlocked everything again.
        $user->shoppingLists()->create(['name' => 'Groceries']);

        $this->deleteJson('/api/encryption?credential_id=cred-a')->assertOk();

        // A key that opens nothing protects nothing, and keeping it would mean an account can
        // never get back to having no encryption at all.
        $this->assertSame(0, $user->encryptionKeys()->count());
    }

    public function test_removing_a_credential_that_is_not_yours_is_not_found(): void
    {
        $other = User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Other',
            'email' => uniqid().'@example.test',
        ]);
        UserEncryption::create([
            'user_id' => $other->id,
            'credential_id' => 'theirs',
            'hkdf_salt' => 'salt',
            'wrapped_key' => 'key',
        ]);

        $user = $this->actingUser();
        $this->putJson('/api/encryption', $this->payload('cred-a'))->assertCreated();
        $this->putJson('/api/encryption', $this->payload('cred-b'))->assertCreated();

        // Two of their own, so the "last row" rule is not what refuses this.
        $this->deleteJson('/api/encryption?credential_id=theirs')->assertStatus(404);
        $this->assertSame(2, $user->encryptionKeys()->count());
        $this->assertSame(1, $other->encryptionKeys()->count());
    }

    public function test_the_endpoints_need_a_logged_in_user(): void
    {
        $this->getJson('/api/encryption')->assertStatus(401);
        $this->putJson('/api/encryption', $this->payload())->assertStatus(401);
        $this->deleteJson('/api/encryption?credential_id=cred-a')->assertStatus(401);
    }

    public function test_deleting_the_user_takes_their_wrapped_keys_with_it(): void
    {
        $user = $this->actingUser();
        $this->putJson('/api/encryption', $this->payload())->assertCreated();

        $user->delete();

        $this->assertSame(0, UserEncryption::count());
    }
}
