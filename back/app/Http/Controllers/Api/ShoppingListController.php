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
    public function index(Request $request): JsonResponse
    {
        $lists = $request->user()->shoppingLists()
            ->withCount('items')
            ->orderBy('position')
            ->get(['id', 'name', 'position', 'created_at']);

        return ApiResponse::success($lists);
    }

    public function reorder(Request $request): JsonResponse
    {
        $data = $request->validate([
            'ids' => 'required|array',
            'ids.*' => 'integer',
        ]);

        $ownedIds = $request->user()->shoppingLists()->pluck('id')->all();

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
        $data = $request->validate(['name' => 'required|string|max:255']);

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
            'name' => 'sometimes|required|string|max:255',
            'items' => 'sometimes|array',
            'items.*.name' => 'nullable|string|max:255',
            'items.*.quantity' => 'nullable|string|max:255',
        ]);

        $list = $this->findOwned($request);

        DB::transaction(function () use ($list, $data) {
            if (array_key_exists('name', $data)) {
                $list->update(['name' => $data['name']]);
            }

            if (array_key_exists('items', $data)) {
                $list->items()->delete();
                foreach (array_values($data['items']) as $position => $item) {
                    $list->items()->create([
                        'name' => $item['name'] ?? '',
                        'quantity' => $item['quantity'] ?? null,
                        'position' => $position,
                    ]);
                }
            }
        });

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
            'items' => $list->items()->get(['id', 'name', 'quantity', 'position']),
        ];
    }
}
