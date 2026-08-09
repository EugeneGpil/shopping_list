<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * That the rules still fire now they live in request classes rather than in the controller.
 *
 * The refactor moved every rule out of `ShoppingListController`, and the failure mode of
 * getting that wrong is silent: a request class whose `rules()` is never consulted validates
 * nothing and the endpoint quietly accepts anything. These tests are the tripwire for that,
 * one per request class that has a rule worth breaking.
 */
class ShoppingListValidationTest extends TestCase
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

    public function test_creating_a_list_needs_a_name(): void
    {
        $this->actingUser();

        $this->postJson('/api/shopping-lists', [])->assertStatus(422);
    }

    public function test_reordering_needs_ids(): void
    {
        $this->actingUser();

        $this->putJson('/api/shopping-lists/order', [])->assertStatus(422);
    }

    /** `show`, `update` and `destroy` all take the list from the query string. */
    public function test_the_list_id_is_required_on_every_endpoint_that_names_one(): void
    {
        $this->actingUser();

        $this->getJson('/api/shopping-list')->assertStatus(422);
        $this->putJson('/api/shopping-list', ['name' => 'x'])->assertStatus(422);
        $this->deleteJson('/api/shopping-list')->assertStatus(422);
    }

    public function test_a_bad_field_type_is_refused(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Groceries', 'position' => 0]);

        $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'items' => [['name' => 'milk', 'checked' => 'not-a-boolean']],
        ])->assertStatus(422);
    }

    /**
     * Ownership is not a validation rule — it stays scoped in the controller, so somebody
     * else's list is missing rather than forbidden. Pinned here because moving it into
     * `authorize()` would turn this 404 into a 403 and leak that the list exists.
     */
    public function test_another_users_list_is_not_found_rather_than_forbidden(): void
    {
        $other = User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Other',
            'email' => uniqid().'@example.test',
        ]);
        $theirs = $other->shoppingLists()->create(['name' => 'Theirs', 'position' => 0]);

        $this->actingUser();

        $this->getJson('/api/shopping-list?list_id='.$theirs->id)->assertStatus(404);
    }
}
