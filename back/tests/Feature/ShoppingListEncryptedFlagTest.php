<?php

namespace Tests\Feature;

use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * The per-list `encrypted` flag (`docs/go_encrypted.md` §5).
 *
 * The property that matters is **mixed state**: switching encryption on rewrites lists one at
 * a time, so a client that dies halfway must be able to come back and see exactly which rows
 * it already did. Nothing else can tell it — ciphertext and a list named `V2Vla2VuZA==` look
 * identical — so the flag has to survive every read path and be settable in the same write as
 * the content it describes.
 */
class ShoppingListEncryptedFlagTest extends TestCase
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

    private function makeList(User $user, string $name = 'Groceries'): ShoppingList
    {
        return $user->shoppingLists()->create(['name' => $name, 'position' => 0]);
    }

    public function test_a_list_is_plaintext_unless_it_says_otherwise(): void
    {
        $user = $this->actingUser();

        // The default is what makes every pre-encryption row correct without a backfill.
        $this->assertFalse($this->makeList($user)->encrypted);
    }

    public function test_a_list_can_be_created_already_encrypted(): void
    {
        $user = $this->actingUser();

        $response = $this->postJson('/api/shopping-lists', [
            'name' => 'Y2lwaGVydGV4dA==',
            'encrypted' => true,
        ]);

        $response->assertCreated();
        $response->assertJsonPath('data.encrypted', true);
        $this->assertTrue($user->shoppingLists()->firstOrFail()->encrypted);
    }

    public function test_the_flag_is_set_in_the_same_write_as_the_ciphertext(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        $response = $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'name' => 'Y2lwaGVydGV4dA==',
            'encrypted' => true,
            'items' => [['name' => 'aXRlbQ==', 'quantity' => 'MQ==']],
        ]);

        $response->assertOk();
        $response->assertJsonPath('data.encrypted', true);
        $this->assertTrue($list->fresh()->encrypted);
    }

    public function test_both_read_paths_report_the_flag(): void
    {
        $user = $this->actingUser();
        $plain = $this->makeList($user, 'Plain');
        $secret = $this->makeList($user, 'Y2lwaGVydGV4dA==');
        $secret->update(['encrypted' => true]);

        // index: the client decides per row whether the name it got is displayable.
        $index = $this->getJson('/api/shopping-lists');
        $index->assertOk();
        $flags = collect($index->json('data'))->pluck('encrypted', 'id');
        $this->assertFalse($flags[$plain->id]);
        $this->assertTrue($flags[$secret->id]);

        // show: same question, one list at a time.
        $this->getJson('/api/shopping-list?list_id='.$secret->id)
            ->assertJsonPath('data.encrypted', true);
        $this->getJson('/api/shopping-list?list_id='.$plain->id)
            ->assertJsonPath('data.encrypted', false);
    }

    /**
     * The resumability property, stated as a test: a half-finished enable leaves a mixture,
     * and the mixture reads back exactly.
     */
    public function test_a_half_finished_enable_is_readable_as_a_mixture(): void
    {
        $user = $this->actingUser();
        $done = $this->makeList($user, 'Y2lwaGVydGV4dA==');
        $todo = $this->makeList($user, 'Still plain');

        $this->putJson('/api/shopping-list?list_id='.$done->id, ['encrypted' => true])
            ->assertOk();
        // …and then the client dies here, before reaching $todo.

        $remaining = $user->shoppingLists()->where('encrypted', false)->pluck('id')->all();
        $this->assertSame([$todo->id], $remaining);
    }

    public function test_an_edit_that_says_nothing_about_encryption_leaves_the_flag_alone(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user, 'Y2lwaGVydGV4dA==');
        $list->update(['encrypted' => true]);

        // An older client, or any ordinary edit: it must not quietly declare the list plain.
        $this->putJson('/api/shopping-list?list_id='.$list->id, [
            'items' => [['name' => 'aXRlbQ==']],
        ])->assertOk();

        $this->assertTrue($list->fresh()->encrypted);
    }

    public function test_the_flag_must_be_a_boolean(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);

        $this->putJson('/api/shopping-list?list_id='.$list->id, ['encrypted' => 'yes please'])
            ->assertStatus(422);
    }

    /**
     * The server stores what it was sent, byte for byte, and encrypts nothing itself.
     *
     * This is the tripwire for §5's standing rule against Laravel's `encrypted` cast. That cast
     * uses `APP_KEY`, which lives on the same machine as the database, so adding it would put a
     * key back beside the ciphertext and defeat the point — while looking like extra security.
     * The trap is close at hand: this table has a column *named* `encrypted`, and `encrypted`
     * is also the name of the cast type, so `'encrypted' => 'encrypted'` is one word away from
     * `'encrypted' => 'boolean'`. Read through the query builder rather than Eloquent, because
     * a cast would decrypt on the way out and hide itself from an Eloquent read.
     */
    public function test_the_server_stores_names_exactly_as_sent(): void
    {
        $this->actingUser();
        $name = 'plain text, stored as plain text';

        $this->postJson('/api/shopping-lists', ['name' => $name])->assertCreated();

        $raw = DB::table('shopping_lists')->orderByDesc('id')->value('name');
        $this->assertSame($name, $raw);
    }

    /**
     * Flipping the flag is an ordinary write and bumps `version` like any other. §6 depends on
     * knowing this: the enable pass invalidates other devices' pending offline edits, which is
     * why it says to flush before enabling.
     */
    public function test_setting_the_flag_bumps_the_version(): void
    {
        $user = $this->actingUser();
        $list = $this->makeList($user);
        $before = $list->version;

        $this->putJson('/api/shopping-list?list_id='.$list->id, ['encrypted' => true])
            ->assertOk();

        $this->assertSame($before + 1, $list->fresh()->version);
    }
}
