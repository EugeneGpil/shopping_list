<?php

namespace Tests\Feature;

use App\Http\Presenters\ShoppingListPresenter;
use App\Models\ShoppingList;
use App\Models\ShoppingListItem;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Deleting a list no longer removes it: it goes to the trash and stays recoverable for
 * `config('trash.retention_days')`.
 *
 * Two things are worth pinning here beyond the happy path. One is that a trashed list is
 * genuinely read-only — it is invisible to every live endpoint, so "not editable" is enforced
 * by the API and not only by the client hiding a button. The other is that the trash is
 * per-user like everything else, and that a stranger's trashed list is a 404 rather than a 403
 * that admits it exists.
 */
class ShoppingListTrashTest extends TestCase
{
    use RefreshDatabase;

    private function actingUser(): User
    {
        $user = $this->makeUser();
        Sanctum::actingAs($user);

        return $user;
    }

    private function makeUser(): User
    {
        return User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Test User',
            'email' => uniqid().'@example.test',
        ]);
    }

    private function listWithItem(User $user, string $name = 'Groceries'): ShoppingList
    {
        $list = $user->shoppingLists()->create(['name' => $name, 'position' => 0]);
        $list->items()->create(['name' => 'Milk', 'position' => 0]);

        return $list;
    }

    public function test_deleting_a_list_moves_it_to_the_trash(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);

        $this->deleteJson("/api/shopping-list?list_id={$list->id}")->assertOk();

        // Still there, and so are its rows — that is what makes a restore free.
        $this->assertSoftDeleted('shopping_lists', ['id' => $list->id]);
        $this->assertDatabaseHas('shopping_list_items', ['shopping_list_id' => $list->id]);

        $this->assertSame([], $this->getJson('/api/shopping-lists')->json('data'));
    }

    public function test_the_trash_lists_what_was_deleted(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $entry = $this->getJson('/api/trash')->assertOk()->json('data.0');

        $this->assertSame($list->id, $entry['id']);
        $this->assertSame('Groceries', $entry['name']);
        $this->assertSame(1, $entry['items_count']);
        $this->assertNotNull($entry['deleted_at']);
        // The window the client counts down, computed on the clock that will do the deleting.
        $this->assertSame(
            $list->fresh()->deleted_at->copy()->addDays(config('trash.retention_days'))->toIso8601String(),
            $entry['purge_at'],
        );
    }

    public function test_the_trash_shows_the_newest_deletion_first(): void
    {
        $user = $this->actingUser();
        $first = $this->listWithItem($user, 'First');
        $second = $this->listWithItem($user, 'Second');

        // Same second for both, which is the ordinary case — two taps in a row.
        $this->deleteJson("/api/shopping-list?list_id={$first->id}");
        $this->deleteJson("/api/shopping-list?list_id={$second->id}");

        $ids = collect($this->getJson('/api/trash')->json('data'))->pluck('id')->all();

        $this->assertSame([$second->id, $first->id], $ids);
    }

    public function test_a_trashed_list_can_be_read_in_full(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $data = $this->getJson("/api/trash/list?list_id={$list->id}")->assertOk()->json('data');

        $this->assertSame('Groceries', $data['name']);
        $this->assertSame(['Milk'], collect($data['items'])->pluck('name')->all());
        // The same shape a live list answers with, so the client parses both with one path.
        $this->assertArrayHasKey('encrypted', $data);
        $this->assertArrayHasKey('version', $data);
        $this->assertNotNull($data['purge_at']);
    }

    public function test_a_trashed_list_is_invisible_to_every_live_endpoint(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $this->getJson("/api/shopping-list?list_id={$list->id}")->assertNotFound();
        $this->putJson("/api/shopping-list?list_id={$list->id}", ['name' => 'Edited'])->assertNotFound();
        $this->deleteJson("/api/shopping-list?list_id={$list->id}")->assertNotFound();

        $this->assertSame('Groceries', $list->fresh()->name);
    }

    public function test_restoring_puts_the_list_back_with_its_items(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $data = $this->postJson("/api/trash/restore?list_id={$list->id}")->assertOk()->json('data');

        $this->assertSame(['Milk'], collect($data['items'])->pluck('name')->all());
        $this->assertNull($list->fresh()->deleted_at);
        $this->assertSame([$list->id], collect($this->getJson('/api/shopping-lists')->json('data'))->pluck('id')->all());
        $this->assertSame([], $this->getJson('/api/trash')->json('data'));
    }

    public function test_restoring_keeps_the_position_it_had(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Middle', 'position' => 3]);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $this->postJson("/api/trash/restore?list_id={$list->id}")->assertOk();

        $this->assertSame(3, $list->fresh()->position);
    }

    public function test_a_live_list_cannot_be_restored_or_purged(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);

        $this->postJson("/api/trash/restore?list_id={$list->id}")->assertNotFound();
        $this->deleteJson("/api/trash?list_id={$list->id}")->assertNotFound();

        $this->assertDatabaseHas('shopping_lists', ['id' => $list->id, 'deleted_at' => null]);
    }

    public function test_purging_removes_the_list_and_its_items_for_good(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        $this->deleteJson("/api/trash?list_id={$list->id}")->assertOk();

        $this->assertDatabaseMissing('shopping_lists', ['id' => $list->id]);
        $this->assertDatabaseMissing('shopping_list_items', ['shopping_list_id' => $list->id]);
    }

    public function test_somebody_elses_trashed_list_is_not_found(): void
    {
        $other = $this->makeUser();
        $theirs = $this->listWithItem($other, 'Theirs');
        $theirs->delete();

        $this->actingUser();

        $this->assertSame([], $this->getJson('/api/trash')->json('data'));
        $this->getJson("/api/trash/list?list_id={$theirs->id}")->assertNotFound();
        $this->postJson("/api/trash/restore?list_id={$theirs->id}")->assertNotFound();
        $this->deleteJson("/api/trash?list_id={$theirs->id}")->assertNotFound();

        $this->assertSoftDeleted('shopping_lists', ['id' => $theirs->id]);
    }

    public function test_the_trash_endpoints_require_a_list_id(): void
    {
        $this->actingUser();

        $this->getJson('/api/trash/list')->assertStatus(422);
        $this->postJson('/api/trash/restore')->assertStatus(422);
        $this->deleteJson('/api/trash')->assertStatus(422);
    }

    /**
     * `trashEntry` is the one presented shape carrying a `withCount` attribute, so it is the one
     * that can be handed a list whose count was never loaded. It counts rather than defaults:
     * "0 item(s)" is what the trash page and the delete-for-good confirmation would otherwise
     * say about a list full of rows, and a plausible wrong number is worse than a query.
     */
    public function test_the_trash_entry_counts_items_when_the_query_did_not(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $list->delete();

        $uncounted = ShoppingList::onlyTrashed()->findOrFail($list->id);

        $this->assertSame(1, ShoppingListPresenter::trashEntry($uncounted)['items_count']);
    }

    public function test_deleting_the_account_takes_trashed_lists_with_it(): void
    {
        $user = $this->actingUser();
        $list = $this->listWithItem($user);
        $this->deleteJson("/api/shopping-list?list_id={$list->id}");

        // The user row is not soft-deleted, so the foreign key cascade reaches a trashed list
        // exactly as it reaches a live one. Without this, deleting an account would leave the
        // contents of its trash on disk under a uid nobody can authenticate as again.
        $user->delete();

        $this->assertDatabaseMissing('shopping_lists', ['id' => $list->id]);
        $this->assertDatabaseMissing('shopping_list_items', ['shopping_list_id' => $list->id]);
    }

    /**
     * The trash's one interaction with the encryption rules, and the reason `destroy` there
     * counts trashed lists: a list in the trash is still data the user can ask back, so the
     * only passkey that opens it may not be removed while it is sitting there.
     */
    public function test_the_last_passkey_cannot_be_removed_while_a_trashed_list_is_encrypted(): void
    {
        $user = $this->actingUser();
        $list = $user->shoppingLists()->create(['name' => 'Private', 'position' => 0, 'encrypted' => true]);
        $user->encryptionKeys()->create([
            'credential_id' => 'cred-1',
            'hkdf_salt' => 'salt',
            'wrapped_key' => 'wrapped',
        ]);

        $this->deleteJson("/api/shopping-list?list_id={$list->id}")->assertOk();

        $this->deleteJson('/api/encryption?credential_id=cred-1')->assertStatus(409);

        $this->assertDatabaseHas('user_encryption', ['credential_id' => 'cred-1']);

        // And once nothing encrypted is left anywhere, live or trashed, the key is removable
        // again — a passkey that opens nothing is protecting nothing.
        $this->deleteJson("/api/trash?list_id={$list->id}")->assertOk();
        $this->deleteJson('/api/encryption?credential_id=cred-1')->assertOk();
    }

    public function test_prune_deletes_lists_past_the_window_and_keeps_the_rest(): void
    {
        $user = $this->makeUser();
        $expired = $this->listWithItem($user, 'Expired');
        $recent = $this->listWithItem($user, 'Recent');
        $live = $this->listWithItem($user, 'Live');

        $expired->delete();
        $recent->delete();
        // Past the window by a day, set on the row rather than by travelling the clock so the
        // two deletions above can share a moment.
        $expired->forceFill(['deleted_at' => now()->subDays(config('trash.retention_days') + 1)])->saveQuietly();

        $this->artisan('lists:prune-trash')->assertSuccessful();

        $this->assertDatabaseMissing('shopping_lists', ['id' => $expired->id]);
        $this->assertDatabaseMissing('shopping_list_items', ['shopping_list_id' => $expired->id]);
        $this->assertSoftDeleted('shopping_lists', ['id' => $recent->id]);
        $this->assertDatabaseHas('shopping_lists', ['id' => $live->id, 'deleted_at' => null]);
    }

    /**
     * The window is stated in more places than one language can reach.
     *
     * This file reads `config('trash.retention_days')` everywhere else, so every test here stays
     * green at any value — which is exactly the hole: change the default and the client's
     * countdown, the delete-confirmation copy, the fake server's arithmetic and the published
     * privacy policy all go quietly wrong with both suites passing. The front end pins its own
     * literal to the policy (`front/test/trash.spec.js`); this pins the server's default to the
     * same number, so the pair cannot drift without one of the two suites saying so.
     *
     * Blind to `TRASH_RETENTION_DAYS`, which no test in either language can see. A deployment
     * that overrides it has to move `front/src/utils/trashClock.js` and the policy by hand — the
     * comment at the top of `front/public/privacy.html` is where that is written down.
     */
    public function test_the_retention_window_is_the_one_the_client_counts_down(): void
    {
        $this->assertSame(
            60,
            (int) config('trash.retention_days'),
            'RETENTION_DAYS in front/src/utils/trashClock.js says 60; move both or neither.',
        );
    }

    public function test_prune_dry_run_deletes_nothing(): void
    {
        $user = $this->makeUser();
        $list = $this->listWithItem($user);
        $list->delete();
        $list->forceFill(['deleted_at' => now()->subDays(365)])->saveQuietly();

        $this->artisan('lists:prune-trash --dry-run')->assertSuccessful();

        $this->assertSoftDeleted('shopping_lists', ['id' => $list->id]);
    }

    public function test_prune_refuses_a_window_of_zero_days(): void
    {
        $user = $this->makeUser();
        $list = $this->listWithItem($user);
        $list->delete();

        // A mistyped config value would otherwise empty the trash the moment anything
        // landed in it.
        $this->artisan('lists:prune-trash --days=0')->assertFailed();

        $this->assertSoftDeleted('shopping_lists', ['id' => $list->id]);
        $this->assertSame(ShoppingListItem::count(), 1);
    }
}
