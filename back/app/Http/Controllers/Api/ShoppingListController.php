<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use App\Http\Presenters\ShoppingListPresenter;
use App\Http\Requests\ShoppingList\DestroyShoppingListRequest;
use App\Http\Requests\ShoppingList\ReorderShoppingListsRequest;
use App\Http\Requests\ShoppingList\ShowShoppingListRequest;
use App\Http\Requests\ShoppingList\StoreShoppingListRequest;
use App\Http\Requests\ShoppingList\UpdateShoppingListRequest;
use App\Models\ShoppingList;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ShoppingListController extends Controller
{
    public function index(Request $request): JsonResponse
    {
        // `id` breaks ties: rows sharing a position would otherwise come back in whatever
        // order Postgres happened to produce, which visibly reshuffles between requests.
        $lists = $request->user()->shoppingLists()
            ->withCount('items')
            ->orderBy('position')
            ->orderBy('id')
            // `encrypted` travels with every list everywhere it appears: the index needs it
            // to mark a list as locked, and the editor needs it before it can read the rows.
            ->get(['id', 'name', 'position', 'created_at', 'version', 'encrypted']);

        return ApiResponse::success($lists);
    }

    public function reorder(ReorderShoppingListsRequest $request): JsonResponse
    {
        $data = $request->validated();

        $ownedIds = $request->user()->shoppingLists()->pluck('id')->all();

        // Position is presentation, not content, so this deliberately leaves `version`
        // alone: it is what an offline client's pending edit is based on, and a reorder
        // must not invalidate an edit that is waiting to be pushed.
        $position = 0;
        foreach ($data['ids'] as $id) {
            if (in_array($id, $ownedIds, true)) {
                $request->user()->shoppingLists()
                    ->whereKey($id)
                    ->update(['position' => $position++]);
            }
        }

        return ApiResponse::success(message: 'Reordered');
    }

    public function store(StoreShoppingListRequest $request): JsonResponse
    {
        $data = $request->validated();

        // A new list goes last. Without this every list is created at position 0 and the
        // whole page orders arbitrarily.
        $data['position'] = (int) $request->user()->shoppingLists()->max('position') + 1;

        $list = $request->user()->shoppingLists()->create($data);

        return ApiResponse::success(ShoppingListPresenter::full($list), status: 201);
    }

    public function show(ShowShoppingListRequest $request): JsonResponse
    {
        $list = $this->findOwned($request);

        return ApiResponse::success(ShoppingListPresenter::full($list));
    }

    public function update(UpdateShoppingListRequest $request): JsonResponse
    {
        $data = $request->validated();

        $list = $this->findOwned($request);
        $conflict = false;

        DB::transaction(function () use (&$list, $data, &$conflict) {
            // Re-read the row under a lock so the version check and the write cannot be
            // split by a concurrent update: checked outside the transaction, two devices
            // could both see their own base as current and both write. Ownership was
            // already established by `findOwned`, so the key alone is enough here.
            $list = ShoppingList::whereKey($list->getKey())->lockForUpdate()->firstOrFail();

            $base = $data['base_version'] ?? null;
            if ($base !== null && (int) $base !== (int) $list->version) {
                $conflict = true;

                return;
            }

            if (array_key_exists('name', $data)) {
                $list->update(['name' => $data['name']]);
            }

            if (array_key_exists('show_quantity', $data)) {
                $list->update(['show_quantity' => $data['show_quantity']]);
            }

            if (array_key_exists('show_checkbox', $data)) {
                $list->update(['show_checkbox' => $data['show_checkbox']]);
            }

            // Set in the same write as the ciphertext it describes, which is what makes a
            // half-finished enable safe to resume: the flag and the content it applies to can
            // never disagree, because one transaction carries both.
            if (array_key_exists('encrypted', $data)) {
                $list->update(['encrypted' => $data['encrypted']]);
            }

            if (array_key_exists('items', $data)) {
                $list->items()->delete();
                foreach (array_values($data['items']) as $position => $item) {
                    $list->items()->create([
                        'name' => $item['name'] ?? '',
                        'quantity' => $item['quantity'] ?? null,
                        'checked' => $item['checked'] ?? false,
                        'position' => $position,
                    ]);
                }
            }

            // One bump per accepted write, whatever it changed. Items live in their own
            // table, so an item-only edit would otherwise leave the list row — and the
            // version with it — untouched, and every later conflict check would pass.
            $list->increment('version');
        });

        if ($conflict) {
            return ApiResponse::error(
                'This list was changed elsewhere.',
                409,
                data: ShoppingListPresenter::full($list->fresh()),
            );
        }

        return ApiResponse::success(ShoppingListPresenter::full($list->fresh()));
    }

    /**
     * Move the list to the trash. The row keeps everything it had and only gains a
     * `deleted_at`, which is enough to take it out of every other endpoint here — and leaves
     * `TrashController` able to hand it back for `config('trash.retention_days')` before
     * `lists:prune-trash` removes it for good.
     */
    public function destroy(DestroyShoppingListRequest $request): JsonResponse
    {
        $this->findOwned($request)->delete();

        return ApiResponse::success(message: 'Moved to trash');
    }

    /**
     * The requested list, or a 404.
     *
     * `list_id` is validated by the request class of whichever endpoint called this, so by
     * here it is known to be an integer. The scoping is the authorization: a list belonging to
     * somebody else is not found, which is a better answer than "found, but forbidden".
     */
    private function findOwned(Request $request): ShoppingList
    {
        return $request->user()->shoppingLists()->findOrFail($request->integer('list_id'));
    }
}
