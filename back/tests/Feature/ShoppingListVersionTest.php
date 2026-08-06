<?php

namespace Tests\Feature;

use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The version contract the offline client depends on.
 *
 * `version` is what an offline edit is based on: the client sends it back as
 * `base_version`, and a mismatch has to mean "somebody else wrote". Each test here pins one
 * half of that — what must move the version, and what must not.
 */
class ShoppingListVersionTest extends TestCase
{
    use RefreshDatabase;

    // Built directly rather than through `UserFactory`, which still carries Laravel's stock
    // definition (`password`, `email_verified_at`) and does not match this project's users
    // table — the app authenticates through Firebase.
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

    private function makeList(User $user, string $name = 'Groceries'): ShoppingList
    {
        return $user->shoppingLists()->create(['name' => $name, 'position' => 0]);
    }

    public function test_show_and_index_both_expose_the_version(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        $this->getJson("/api/shopping-list?list_id={$list->id}")
            ->assertOk()
            ->assertJsonPath('data.version', 0);

        $this->getJson('/api/shopping-lists')
            ->assertOk()
            ->assertJsonPath('data.0.version', 0);
    }

    public function test_replacing_items_moves_the_version(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        // Items live in their own table, so without the controller's explicit bump this
        // would leave the list row — and therefore the version — untouched.
        $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Milk', 'quantity' => null, 'checked' => false]],
        ])->assertOk()->assertJsonPath('data.version', 1);

        // And again, because a version that only ever moves once is no version at all.
        $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Bread', 'quantity' => null, 'checked' => false]],
            'base_version' => 1,
        ])->assertOk()->assertJsonPath('data.version', 2);
    }

    public function test_reordering_does_not_move_the_version(): void
    {
        $user = $this->actingUser();
        $first = $this->makeList($user, 'A');
        $second = $this->makeList($user, 'B');

        $this->putJson('/api/shopping-lists/order', ['ids' => [$second->id, $first->id]])
            ->assertOk();

        // Position is presentation. If it moved the version, a device that reorders would
        // invalidate its own pending edits.
        $this->assertSame(0, $second->fresh()->position);
        $this->assertSame(1, $first->fresh()->position);
        $this->assertSame(0, (int) $first->fresh()->version);
    }

    public function test_a_write_based_on_the_current_version_is_accepted(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Milk', 'quantity' => null, 'checked' => false]],
            'base_version' => $list->version,
        ])->assertOk();

        $this->assertSame('Milk', $list->items()->first()->name);
    }

    public function test_a_write_based_on_a_stale_version_is_refused_with_the_winning_copy(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        // Another device gets there first.
        $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Bread', 'quantity' => null, 'checked' => false]],
        ])->assertOk();

        $response = $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Milk', 'quantity' => null, 'checked' => false]],
            'base_version' => 99,
        ])->assertStatus(409);

        // The refusal carries the copy that won, so the client can adopt it without asking
        // again — and nothing of the refused write may have landed.
        $this->assertSame(['Bread'], $response->json('data.items.*.name'));
        $this->assertSame(['Bread'], $list->items()->pluck('name')->all());
    }

    public function test_a_write_with_no_base_still_wins_outright(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        // Version checking is opt-in, so a client that does not track versions keeps the
        // old last-write-wins behaviour rather than being locked out.
        $this->putJson("/api/shopping-list?list_id={$list->id}", [
            'items' => [['name' => 'Milk', 'quantity' => null, 'checked' => false]],
        ])->assertOk();

        $this->assertSame(['Milk'], $list->items()->pluck('name')->all());
    }
}
