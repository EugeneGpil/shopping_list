<?php

namespace App\Http\Presenters;

use App\Models\ShoppingList;

/**
 * The shapes a list is sent to the client in.
 *
 * Here rather than private to a controller because two controllers now answer with a list:
 * `ShoppingListController` for the live ones and `TrashController` for the trashed ones, and
 * the client parses both with the same `recordFromApi`. Stated once so it cannot drift — when
 * `encrypted` was added, a second copy of this array would have been a list the client renders
 * as base64.
 */
class ShoppingListPresenter
{
    /** A list and its rows, as `GET/POST/PUT shopping-list` answer. */
    public static function full(ShoppingList $list): array
    {
        return [
            'id' => $list->id,
            'name' => $list->name,
            'show_quantity' => $list->show_quantity ?? true,
            'show_checkbox' => $list->show_checkbox ?? true,
            // Whether the item fields below are ciphertext. Titles are never encrypted (§1).
            'encrypted' => (bool) $list->encrypted,
            // The version the client edits against: it sends this back as `base_version`,
            // and a mismatch means another device got there first.
            'version' => (int) $list->version,
            'items' => $list->items()->get(['id', 'name', 'quantity', 'checked', 'position']),
        ];
    }

    /**
     * The same, plus when it was trashed and when it will be gone.
     *
     * A trashed list is read-only, but it is read by the same client code as a live one — so
     * it keeps every field a live list has rather than being trimmed to what a read-only view
     * happens to render today.
     */
    public static function trashed(ShoppingList $list): array
    {
        return [...self::full($list), ...self::trashTimes($list)];
    }

    /**
     * One row of the trash page: no items, just enough to name the list and say how long is
     * left.
     *
     * `items_count` is a `withCount` attribute, so it is absent unless the query asked for it.
     * Counted here when it is missing rather than defaulted to zero: the number is rendered as
     * "N item(s)" on the trash page and in the purge confirmation, and a caller that forgot
     * `withCount` would otherwise get a silent, plausible "0 item(s)" for a list full of rows.
     * The extra query is the price of never lying, and only a caller that skipped `withCount`
     * pays it — `TrashController::index` does not.
     */
    public static function trashEntry(ShoppingList $list): array
    {
        return [
            'id' => $list->id,
            'name' => $list->name,
            // Titles are plaintext however a list is stored, so the trash page renders with no
            // key — the flag is only what puts a padlock beside the name.
            'encrypted' => (bool) $list->encrypted,
            'items_count' => (int) ($list->items_count ?? $list->loadCount('items')->items_count),
            ...self::trashTimes($list),
        ];
    }

    /**
     * Sent rather than left to the client to work out, so that the countdown it shows and the
     * deletion `lists:prune-trash` performs are the same arithmetic, done once, on the clock
     * that will actually do the deleting.
     *
     * The `?->` is a belt on an invariant rather than a case that occurs: every caller reaches
     * these rows through `onlyTrashed()`, where `deleted_at` is what makes the row visible at
     * all. It is here so a future caller that passes a live list gets nulls instead of an
     * error — the client renders an empty countdown, which is wrong but not broken.
     */
    private static function trashTimes(ShoppingList $list): array
    {
        return [
            'deleted_at' => $list->deleted_at?->toIso8601String(),
            'purge_at' => $list->deleted_at?->copy()
                ->addDays((int) config('trash.retention_days'))
                ->toIso8601String(),
        ];
    }
}
