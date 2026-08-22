<?php

namespace App\Http\Requests\Trash;

/** `DELETE trash` — remove a trashed list and its items for good, ahead of the retention window. */
class PurgeShoppingListRequest extends TrashRequest {}
