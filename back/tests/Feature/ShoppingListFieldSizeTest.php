<?php

namespace Tests\Feature;

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

    /** Roughly what a 255-character name looks like once encrypted and base64'd. */
    private function ciphertextish(int $length = 1400): string
    {
        return str_repeat('A', $length);
    }

    public function test_a_name_the_size_of_ciphertext_is_accepted(): void
    {
        $this->actingUser();

        $response = $this->postJson('/api/shopping-lists', ['name' => $this->ciphertextish()]);

        $response->assertCreated();
        // Stored whole: the column is `text`, so nothing silently truncated on the way in.
        $this->assertSame(1400, mb_strlen(ShoppingList::firstOrFail()->name));
    }

    public function test_items_the_size_of_ciphertext_are_accepted(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Groceries', 'position' => 0]);

        $response = $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'items' => [
                ['name' => $this->ciphertextish(), 'quantity' => $this->ciphertextish()],
            ],
        ]);

        $response->assertOk();
        $item = $list->items()->firstOrFail();
        $this->assertSame(1400, mb_strlen($item->name));
        $this->assertSame(1400, mb_strlen($item->quantity));
    }

    public function test_the_cap_still_bites_above_the_limit(): void
    {
        $this->actingUser();

        // Still a guard, not an open door — the point of a cap is that something is refused.
        $this->postJson('/api/shopping-lists', ['name' => $this->ciphertextish(2049)])
            ->assertStatus(422);
    }
}
