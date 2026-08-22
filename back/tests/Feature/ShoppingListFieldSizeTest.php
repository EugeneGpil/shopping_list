<?php

namespace Tests\Feature;

use App\Http\Requests\ShoppingList\ShoppingListRequest;
use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The size a list name or item can be, now that it may be ciphertext.
 *
 * The old `max:255` was a content rule; it is a request-size guard now
 * (`docs/go_encrypted.md` §5). These tests exist because the number is easy to "tidy" back
 * to 255 by someone who does not know an encrypted 255-character name is roughly 1400 bytes
 * — and the failure that would cause is a rejected sync, not an obvious bug.
 *
 * The last test is the one that was missing, and the bug it now covers: the cap was derived
 * from plaintext, so an 1800-character item that saved in the clear was refused the moment its
 * list was locked. The property is that an item behaves the same either way, which nothing here
 * used to state — both of the ciphertext tests above it used a made-up length rather than an
 * actual sealed field, so neither could notice that a real one no longer fitted.
 */
class ShoppingListFieldSizeTest extends TestCase
{
    use RefreshDatabase;

    // Built directly rather than through `UserFactory`, which still carries Laravel's stock
    // definition and does not match this project's Firebase-authenticated users table.
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

    private function filler(int $length): string
    {
        return str_repeat('A', $length);
    }

    /**
     * One field as the client actually sends it: `base64(iv ‖ ciphertext ‖ tag)`, the same
     * envelope `encryptField` writes in `front/src/utils/crypto.js`.
     *
     * Real AES-GCM rather than a string of the right length, because the length is the thing
     * under test and restating the arithmetic here would only prove that this file and the
     * docblock agree with each other.
     */
    private function sealed(string $plaintext): string
    {
        $iv = random_bytes(12);
        $tag = '';
        $ciphertext = openssl_encrypt(
            $plaintext,
            'aes-256-gcm',
            random_bytes(32),
            OPENSSL_RAW_DATA,
            $iv,
            $tag
        );

        return base64_encode($iv.$ciphertext.$tag);
    }

    public function test_a_name_at_the_cap_is_accepted(): void
    {
        $this->actingUser();

        $response = $this->postJson('/api/shopping-lists', [
            'name' => $this->filler(ShoppingListRequest::MAX_FIELD),
        ]);

        $response->assertCreated();
        // Stored whole: the column is `text`, so nothing silently truncated on the way in.
        $this->assertSame(
            ShoppingListRequest::MAX_FIELD,
            mb_strlen(ShoppingList::firstOrFail()->name)
        );
    }

    public function test_items_at_the_cap_are_accepted(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Groceries', 'position' => 0]);
        $field = $this->filler(ShoppingListRequest::MAX_FIELD);

        $response = $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'items' => [['name' => $field, 'quantity' => $field]],
        ]);

        $response->assertOk();
        $item = $list->items()->firstOrFail();
        $this->assertSame(ShoppingListRequest::MAX_FIELD, mb_strlen($item->name));
        $this->assertSame(ShoppingListRequest::MAX_FIELD, mb_strlen($item->quantity));
    }

    public function test_the_cap_still_bites_one_character_above_it(): void
    {
        $this->actingUser();

        // Still a guard, not an open door — the point of a cap is that something is refused.
        $this->postJson('/api/shopping-lists', [
            'name' => $this->filler(ShoppingListRequest::MAX_FIELD + 1),
        ])->assertStatus(422);
    }

    public function test_ciphertext_of_a_maximum_length_plaintext_item_is_accepted(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Groceries', 'position' => 0]);

        // The widest plaintext the cap is derived from, in the widest characters UTF-8 has: 2048
        // codepoints — what `max:2048` allowed before this — of four bytes each. Anything an
        // alphabet can write is shorter.
        $plaintext = str_repeat('😀', 2048);
        $blob = $this->sealed($plaintext);

        $response = $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'encrypted' => true,
            'items' => [['name' => $blob, 'quantity' => $blob]],
        ]);

        // The assertion that names the bug: this is a 2048-character item, and it has to be
        // accepted sealed exactly as it was accepted in the clear.
        $response->assertOk();
        $this->assertSame(2048, mb_strlen($plaintext));
        $this->assertSame(10960, mb_strlen($blob));
        $this->assertSame($blob, $list->items()->firstOrFail()->name);
    }
}
