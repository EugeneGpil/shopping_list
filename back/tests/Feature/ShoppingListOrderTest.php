<?php

namespace Tests\Feature;

use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The list page renders whatever order `index` returns — the front does no sorting of its
 * own. So the ordering has to be total and stable here, or the page visibly reshuffles
 * between visits.
 */
class ShoppingListOrderTest extends TestCase
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

    public function test_a_created_list_goes_last(): void
    {
        $user = $this->actingUser();
        $user->shoppingLists()->create(['name' => 'First', 'position' => 0]);
        $user->shoppingLists()->create(['name' => 'Second', 'position' => 7]);

        $this->postJson('/api/shopping-lists', ['name' => 'Third'])->assertCreated();

        $this->assertSame(8, ShoppingList::where('name', 'Third')->value('position'));
    }

    public function test_positions_are_per_user(): void
    {
        $other = User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Other',
            'email' => uniqid().'@example.test',
        ]);
        $other->shoppingLists()->create(['name' => 'Theirs', 'position' => 99]);

        $this->actingUser();
        $this->postJson('/api/shopping-lists', ['name' => 'Mine'])->assertCreated();

        // Someone else's high position must not push my first list down.
        $this->assertSame(1, ShoppingList::where('name', 'Mine')->value('position'));
    }

    public function test_lists_sharing_a_position_keep_a_stable_order(): void
    {
        $user = $this->actingUser();

        // The shape left behind by lists created before `store` assigned a position.
        $first = $user->shoppingLists()->create(['name' => 'A', 'position' => 0]);
        $second = $user->shoppingLists()->create(['name' => 'B', 'position' => 0]);
        $third = $user->shoppingLists()->create(['name' => 'C', 'position' => 0]);

        // Touching a row is what makes Postgres hand back a different physical order.
        $second->update(['name' => 'B edited']);

        $ids = collect($this->getJson('/api/shopping-lists')->json('data'))->pluck('id')->all();

        $this->assertSame([$first->id, $second->id, $third->id], $ids);
    }

    public function test_index_honours_position_over_id(): void
    {
        $user = $this->actingUser();
        $a = $user->shoppingLists()->create(['name' => 'A', 'position' => 2]);
        $b = $user->shoppingLists()->create(['name' => 'B', 'position' => 0]);
        $c = $user->shoppingLists()->create(['name' => 'C', 'position' => 1]);

        $ids = collect($this->getJson('/api/shopping-lists')->json('data'))->pluck('id')->all();

        $this->assertSame([$b->id, $c->id, $a->id], $ids);
    }
}
