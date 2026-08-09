<?php

namespace App\Console\Commands;

use App\Models\ShoppingList;
use App\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use ZipArchive;

class ImportKeepNotes extends Command
{
    protected $signature = 'keep:import
                            {path : Google Takeout archive (.zip) or an unpacked Takeout/Keep folder}
                            {--email= : Email of the user the imported lists belong to}
                            {--archived : Also import archived notes (skipped by default)}
                            {--text : Also import plain-text notes, one item per line}
                            {--dry-run : Report what would be imported without writing anything}';

    protected $description = 'Import Google Keep checklists from a Takeout export as shopping lists';

    public function handle(): int
    {
        $user = User::where('email', $this->option('email'))->first();

        if (! $user) {
            $this->error('No user with email '.($this->option('email') ?: '(none given)').'. Pass --email=');

            return self::FAILURE;
        }

        $notes = $this->readNotes($this->argument('path'));

        if ($notes === null) {
            return self::FAILURE;
        }

        if ($notes === []) {
            $this->error('No Keep .json notes found. Point --path at the Takeout .zip or its Takeout/Keep folder.');

            return self::FAILURE;
        }

        $this->line(count($notes).' note(s) found.');

        // Imported lists append after whatever the user already has, so an import never
        // reshuffles their existing ordering.
        $position = (int) $user->shoppingLists()->max('position');
        $imported = 0;
        $skipped = [];

        foreach ($notes as $note) {
            $name = $this->listName($note);

            if ($note['isTrashed'] ?? false) {
                $skipped[] = "{$name}: in Keep's trash";

                continue;
            }

            if (($note['isArchived'] ?? false) && ! $this->option('archived')) {
                $skipped[] = "{$name}: archived (use --archived)";

                continue;
            }

            $items = $this->items($note);

            // A note whose items were all ticked off carries nothing once the checked ones
            // are dropped, so it would land as an empty list. Report it instead.
            if ($items === []) {
                $skipped[] = "{$name}: ".(is_array($note['listContent'] ?? null)
                    ? 'no unchecked items'
                    : 'plain-text note (use --text)');

                continue;
            }

            $this->line(sprintf('  %s — %d item(s)', $name, count($items)));

            if ($this->option('dry-run')) {
                $imported++;

                continue;
            }

            DB::transaction(function () use ($user, $name, $items, &$position) {
                /** @var ShoppingList $list */
                $list = $user->shoppingLists()->create([
                    'name' => $name,
                    'position' => ++$position,
                    // Keep has no per-item quantity, so every imported row would show an
                    // empty column.
                    'show_quantity' => false,
                ]);

                foreach ($items as $index => $text) {
                    $list->items()->create([
                        'name' => $text,
                        'position' => $index,
                        'checked' => false,
                    ]);
                }
            });

            $imported++;
        }

        foreach ($skipped as $reason) {
            $this->warn('  skipped '.$reason);
        }

        $this->info(sprintf(
            '%s %d list(s) for %s, skipped %d.',
            $this->option('dry-run') ? 'Would import' : 'Imported',
            $imported,
            $user->email,
            count($skipped),
        ));

        return self::SUCCESS;
    }

    /**
     * Decoded Keep notes from either an unpacked folder or the Takeout zip itself,
     * or null when the path cannot be read.
     *
     * @return array<int, array<string, mixed>>|null
     */
    private function readNotes(string $path): ?array
    {
        if (is_dir($path)) {
            $notes = [];

            foreach (glob(rtrim($path, '/').'/*.json') as $file) {
                $note = $this->decode(file_get_contents($file));

                if ($note !== null) {
                    $notes[] = $note;
                }
            }

            return $notes;
        }

        if (! is_file($path)) {
            $this->error("No such file or directory: {$path}");

            return null;
        }

        if (! class_exists(ZipArchive::class)) {
            $this->error('Reading the archive directly needs ext-zip. Unzip it and pass the Takeout/Keep folder instead.');

            return null;
        }

        $zip = new ZipArchive;

        if ($zip->open($path) !== true) {
            $this->error("Could not open {$path} as a zip archive.");

            return null;
        }

        $notes = [];

        for ($i = 0; $i < $zip->numFiles; $i++) {
            $entry = $zip->getNameIndex($i);

            // Keep's notes live in Takeout/Keep/*.json alongside .html renderings of the
            // same content and any image attachments.
            if (! str_contains($entry, '/Keep/') || ! str_ends_with($entry, '.json')) {
                continue;
            }

            $note = $this->decode($zip->getFromIndex($i));

            if ($note !== null) {
                $notes[] = $note;
            }
        }

        $zip->close();

        return $notes;
    }

    /**
     * @return array<string, mixed>|null
     */
    private function decode(string $json): ?array
    {
        $note = json_decode($json, true);

        // Keep also ships Labels.json, which is a different shape and not a note.
        if (! is_array($note) || (! isset($note['listContent']) && ! isset($note['textContent']))) {
            return null;
        }

        return $note;
    }

    /**
     * The unchecked item texts of a note, in Keep's own order.
     *
     * @param  array<string, mixed>  $note
     * @return array<int, string>
     */
    private function items(array $note): array
    {
        $texts = [];

        if (is_array($note['listContent'] ?? null)) {
            foreach ($note['listContent'] as $entry) {
                if ($entry['isChecked'] ?? false) {
                    continue;
                }

                $texts[] = (string) ($entry['text'] ?? '');
            }
        } elseif ($this->option('text')) {
            $texts = preg_split('/\R/', (string) ($note['textContent'] ?? ''));
        }

        return collect($texts)
            ->map(fn (string $text) => Str::limit(trim($text), 255, ''))
            ->filter(fn (string $text) => $text !== '')
            ->values()
            ->all();
    }

    /**
     * @param  array<string, mixed>  $note
     */
    private function listName(array $note): string
    {
        $title = Str::limit(trim((string) ($note['title'] ?? '')), 255, '');

        if ($title !== '') {
            return $title;
        }

        // Untitled notes are common in Keep; date them so they stay tellable apart.
        $created = (int) ($note['createdTimestampUsec'] ?? 0);

        return 'Keep '.($created > 0
            ? date('Y-m-d', intdiv($created, 1_000_000))
            : 'note');
    }
}
