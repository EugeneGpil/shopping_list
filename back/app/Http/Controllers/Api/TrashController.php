<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use App\Http\Presenters\ShoppingListPresenter;
use App\Http\Requests\Trash\PurgeShoppingListRequest;
use App\Http\Requests\Trash\RestoreShoppingListRequest;
use App\Http\Requests\Trash\ShowTrashedListRequest;
use App\Models\ShoppingList;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * The trash: lists that have been deleted but are not gone yet.
 *
 * `DELETE shopping-list` soft-deletes, so a deleted list keeps everything it had — rows,
 * settings, `encrypted` flag — and simply stops being visible to every other endpoint, which
 * Eloquent's soft-delete scope does for free. This controller is the only place that hands one
 * back to a client, and it offers exactly three things to do with one: read it, restore it, or
 * remove it for good. There is deliberately no write path here — editing a list means restoring
 * it first, which is also what makes "trashed lists are read-only" a fact about the API rather
 * than a rule the client is asked to respect.
 *
 * Anything nobody comes back for is removed by `lists:prune-trash` after
 * `config('trash.retention_days')`.
 */
class TrashController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        // Newest first, unlike the index: the trash is not arranged by the user and the list
        // most likely to be wanted back is the one just deleted. `id` breaks ties for the
        // same reason it does on the index — several lists deleted in one tap-tap-tap share a
        // timestamp to the second.
        $lists = $request->user()->shoppingLists()
            ->onlyTrashed()
            ->withCount('items')
            ->orderByDesc('deleted_at')
            ->orderByDesc('id')
            ->get();

        return ApiResponse::success(
            $lists->map(fn (ShoppingList $list) => ShoppingListPresenter::trashEntry($list))->all(),
        );
    }

    /**
     * One trashed list in full, for inspecting it before deciding.
     *
     * The same shape `GET shopping-list` answers with, because the client parses it with the
     * same code — including decrypting the rows of a locked list, which needs a passkey here
     * exactly as it does in the editor.
     */
    public function show(ShowTrashedListRequest $request): JsonResponse
    {
        return ApiResponse::success(ShoppingListPresenter::trashed($this->findTrashed($request)));
    }

    /**
     * Put it back.
     *
     * Its `position` is left as it was, so it returns roughly where the user remembers it
     * rather than at the end. That can tie with a list that has since taken the same position,
     * and the index breaks ties by `id` — a stable order either way, and the user can drag it
     * where they want it.
     */
    public function restore(RestoreShoppingListRequest $request): JsonResponse
    {
        $list = $this->findTrashed($request);
        $list->restore();

        return ApiResponse::success(ShoppingListPresenter::full($list), message: 'Restored');
    }

    /**
     * Remove it now instead of waiting out the retention window. The items go with it through
     * the foreign key's `cascadeOnDelete`, which only a real delete triggers.
     */
    public function destroy(PurgeShoppingListRequest $request): JsonResponse
    {
        $this->findTrashed($request)->forceDelete();

        return ApiResponse::success(message: 'Deleted permanently');
    }

    /**
     * The requested trashed list, or a 404.
     *
     * `onlyTrashed`, not `withTrashed`: a live list is not in the trash, so restoring or
     * purging one through these endpoints is not a thing that half-works — it is a 404, the
     * same answer somebody else's list gets. The scoping to the caller is the authorization,
     * as on the live endpoints.
     */
    private function findTrashed(Request $request): ShoppingList
    {
        return $request->user()->shoppingLists()
            ->onlyTrashed()
            ->findOrFail($request->integer('list_id'));
    }
}
