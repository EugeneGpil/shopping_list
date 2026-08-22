<?php

namespace Tests\Feature;

use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\Sanctum;
use Tests\TestCase;

/**
 * Everything under `api/` answers JSON, whatever the request asked for.
 *
 * The client always sends `Accept: application/json`, so none of this is on a user's path.
 * What made it worth closing is the shape of the failure when something else calls in: the
 * auth middleware redirects an unauthenticated non-JSON request to a named `login` route,
 * this app has none, and the redirect threw — so the one boundary that exists to say "no"
 * answered with a 500 and, under `APP_DEBUG`, a stack trace of the app behind it.
 *
 * Both halves of `bootstrap/app.php` are needed and each is pinned here, because either one
 * alone looks like it is enough: `redirectGuestsTo(null)` is what turns the 500 into a 401 —
 * the redirect is built before the exception exists, so no rendering rule can reach it — and
 * `shouldRenderJsonWhen` is what makes that 401, and every other failure under `api/`, JSON.
 *
 * So these tests deliberately send no `Accept` header. `getJson` and friends would pass
 * against the unfixed app, which is exactly how this went unnoticed.
 */
class ApiErrorResponseTest extends TestCase
{
    use RefreshDatabase;

    private function makeUser(): User
    {
        return User::create([
            'firebase_uid' => 'uid-'.uniqid(),
            'name' => 'Test User',
            'email' => uniqid().'@example.test',
        ]);
    }

    public function test_an_unauthenticated_api_request_without_an_accept_header_is_a_401(): void
    {
        $response = $this->get('/api/shopping-lists');

        $response->assertStatus(401);
        $response->assertHeader('content-type', 'application/json');
        // Laravel's own envelope, not `ApiResponse`'s — see the envelope test below. Pinned
        // exactly, because the tempting follow-up is to render this through `ApiResponse::error`
        // so the two agree, and that would change what a client parses on the auth boundary.
        $response->assertExactJson(['message' => 'Unauthenticated.']);
    }

    /**
     * Two envelopes now reach a client under `api/*`, and which one arrives depends on who wrote
     * the answer.
     *
     * A controller answers through `App\Http\ApiResponse`, always three keys: `data`, `message`,
     * `errors` — every success, and the deliberate refusals (the 409 from a stale `base_version`,
     * the 409 on the last passkey). Everything the framework renders instead carries `message`
     * alone, plus `errors` on a validation failure: the 401 above, a `firstOrFail` 404, an
     * unhandled 500. The front end reads `body.data` on the 409 and `body.message` nowhere it is
     * not the server's own sentence, so the split is liveable — but it is a split, and this is
     * the assertion that notices if either half moves.
     */
    public function test_a_controller_answer_carries_the_api_response_envelope(): void
    {
        Sanctum::actingAs($this->makeUser());

        $response = $this->get('/api/shopping-lists');

        $response->assertOk();
        $response->assertJsonStructure(['data', 'message', 'errors']);
    }

    public function test_the_trash_answers_the_same_way(): void
    {
        // Its own case rather than a loop, because "the fix is global" is the claim being
        // made: the trash routes were the ones the tester happened to hit, and the middleware
        // group they sit in is what decides.
        $response = $this->get('/api/trash');

        $response->assertStatus(401);
        $response->assertHeader('content-type', 'application/json');
    }

    public function test_asking_for_json_still_gets_the_same_401(): void
    {
        $this->getJson('/api/shopping-lists')->assertStatus(401);
    }

    public function test_a_missing_list_is_a_json_404_rather_than_an_html_error_page(): void
    {
        Sanctum::actingAs($this->makeUser());

        $response = $this->get('/api/shopping-list?list_id=999');

        $response->assertStatus(404);
        $response->assertHeader('content-type', 'application/json');
    }

    public function test_a_refused_write_is_a_json_422_rather_than_a_redirect_back(): void
    {
        $user = $this->makeUser();
        Sanctum::actingAs($user);
        /** @var ShoppingList $list */
        $list = $user->shoppingLists()->create(['name' => 'Groceries', 'position' => 0]);

        // Without the fix a failed `FormRequest` on a non-JSON request redirects to the
        // previous page with the errors in the session — a 302 to a page this app does not
        // have, which tells an API client nothing about what was wrong.
        $response = $this->put("/api/shopping-list?list_id={$list->id}", ['name' => '']);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('name');
    }

    public function test_the_web_route_still_answers_with_its_page(): void
    {
        // The scoping is `api/*`, so the one non-API route in the app has to be untouched —
        // an HTML page, not a JSON envelope.
        $response = $this->get('/');

        $response->assertOk();
        $this->assertStringContainsString('text/html', $response->headers->get('content-type'));
    }
}
