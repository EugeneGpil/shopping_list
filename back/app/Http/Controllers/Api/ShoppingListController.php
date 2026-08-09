<?php

namespace App\Http\Controllers\Api;

use App\Http\ApiResponse;
use App\Http\Controllers\Controller;
use App\Models\ShoppingList;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class ShoppingListController extends Controller
{
    /**
     * The cap on any field holding user content.
     *
     * This is **not** a content rule. Once a client encrypts (`docs/go_encrypted.md`), what
     * arrives here is base64 of AES-GCM and the server cannot say anything about the text
     * inside it — not its length, not whether it is text at all. What is left is a guard on
     * request size, and that is all this is now.
     *
     * Where the number comes from: 255 characters of plaintext is up to 1020 bytes in UTF-8,
     * plus a 12-byte IV and a 16-byte tag, base64'd — about 1400. 2048 clears that with room
     * for the encoding to change, and is still small enough that a runaway client cannot post
     * megabytes an item. The matching columns are `text` (migration
     * 2026_08_09_000002), so nothing truncates below this.
     */
    private const MAX_FIELD = 2048;

    public function index(Request $request): JsonResponse
    {
        // `id` breaks ties: rows sharing a position would otherwise come back in whatever
        // order Postgres happened to produce, which visibly reshuffles between requests.
        $lists = $request->user()->shoppingLists()
            ->withCount('items')
            ->orderBy('position')
            ->orderBy('id')
            ->get(['id', 'name', 'position', 'created_at', 'version']);

        return ApiResponse::success($lists);
    }

    public function reorder(Request $request): JsonResponse
    {
        $data = $request->validate([
            'ids' => 'required|array',
            'ids.*' => 'integer',
        ]);

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

    public function store(Request $request): JsonResponse
    {
        // `store` is on the encrypted path too — a list created after encryption is switched
        // on arrives here already ciphertext — so it takes the same cap as `update`.
        $data = $request->validate(['name' => 'required|string|max:'.self::MAX_FIELD]);

        // A new list goes last. Without this every list is created at position 0 and the
        // whole page orders arbitrarily.
        $data['position'] = (int) $request->user()->shoppingLists()->max('position') + 1;

        $list = $request->user()->shoppingLists()->create($data);

        return ApiResponse::success($this->present($list), status: 201);
    }

    public function show(Request $request): JsonResponse
    {
        $list = $this->findOwned($request);

        return ApiResponse::success($this->present($list));
    }

    public function update(Request $request): JsonResponse
    {
        $data = $request->validate([
            'name' => 'sometimes|required|string|max:'.self::MAX_FIELD,
            'show_quantity' => 'sometimes|boolean',
            'show_checkbox' => 'sometimes|boolean',
            'items' => 'sometimes|array',
            'items.*.name' => 'nullable|string|max:'.self::MAX_FIELD,
            'items.*.quantity' => 'nullable|string|max:'.self::MAX_FIELD,
            'items.*.checked' => 'nullable|boolean',
            // The `version` the client's copy was based on. Optional: a client that does
            // not track versions keeps the old last-write-wins behaviour.
            'base_version' => 'sometimes|nullable|integer',
        ]);

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
                data: $this->present($list->fresh()),
            );
        }

        return ApiResponse::success($this->present($list->fresh()));
    }

    public function destroy(Request $request): JsonResponse
    {
        $this->findOwned($request)->delete();

        return ApiResponse::success(message: 'Deleted');
    }

    private function findOwned(Request $request): ShoppingList
    {
        $request->validate(['list_id' => 'required|integer']);

        return $request->user()->shoppingLists()->findOrFail($request->integer('list_id'));
    }

    private function present(ShoppingList $list): array
    {
        return [
            'id' => $list->id,
            'name' => $list->name,
            'show_quantity' => $list->show_quantity ?? true,
            'show_checkbox' => $list->show_checkbox ?? true,
            // The version the client edits against: it sends this back as `base_version`,
            // and a mismatch means another device got there first.
            'version' => (int) $list->version,
            'items' => $list->items()->get(['id', 'name', 'quantity', 'checked', 'position']),
        ];
    }
}
