Claude Opus 5.5, read-only review. Session `4d67a881-e20e-4306-a984-5bf3bd34d1fe`. The original file inventory is placed before the analysis below.

```
.review/
|-- changed-files.txt
|-- changes.patch            (all 1662 lines)
`-- tests.log
apps/honeycrisp/
|-- AGENTS.md
|-- host/
|   |-- serve.ts
|   `-- serve.test.ts        (via patch + fixture grep)
`-- src/
    |-- lib/
    |   |-- data.ts
    |   |-- draft.svelte.ts
    |   |-- files.ts
    |   |-- note-source.ts
    |   |-- notes.svelte.ts
    |   |-- notes.test.ts
    |   |-- bridge/{contract.ts, notes-host.ts, transport.ts}
    |   |-- editor/rich-session.ts
    |   `-- platform/{types.ts, notes-host.tauri.ts, notes-host.browser.ts}
    `-- routes/
        |-- +page.svelte
        `-- components/{NotesView, NoteDetail, NoteList, FileView, FileBrowser,
                        DraftStatus, RichEditor, NoteHistory}.svelte, file-actions.ts
packages/app/src/files/{folder.ts, table.ts}
```

# Honeycrisp collapse review (read-only, nothing executed)

**Verdict:** not clean. The single-registry model is right and should stay, but the collapse introduced one deterministic regression: an opened raw text file can no longer be deleted. There is also one stale-observation race the new loop widens, and one draft-overwrite path in `retarget`. All findings come from reading the code; I ran nothing.

## Files read



Not read: `README.md` beyond the patch hunks and one grep hit, `.review/types.log`, `host/main.ts`, `FileNameBar.svelte`, `FolderNav.svelte`, `codec.ts`, and the `.review/before` tree (the patch served as the baseline).

## Correctness findings

### F1. High, this diff: deleting an opened raw text file is always refused
- **Where:** `apps/honeycrisp/src/lib/notes.svelte.ts:734-739`.
- **Cause:** the guard was `editors.has(path) || notePaths.has(path)`, where `editors` held notes only. It is now `editorAt(path) !== undefined || notePaths.has(path)`, which is true for every open text file.
- **Sequence:**
  1. Open `scratch.txt`, then press Delete in `FileView` or `FileBrowser`.
  2. `confirmDelete` calls `deletionFor`, which calls `noteForOperation`, which calls `readNote('scratch.txt')`.
  3. `noteIdOf` is undefined, so `readNote` returns `unreadable: "scratch.txt is not a note file."` (`:168-170`).
  4. The person sees the toast "Could not delete scratch.txt".
- **Why it sticks:** the draft is retained for the session, so the only way out is the terminal.
- **Dead code:** the raw-file branch at `:740-744` is now unreachable.
- **Fix direction:** use the predicate `rename` already has at `:671-674`: `notePaths.has(path) || (noteIdOf(path) !== undefined && editorAt(path) !== undefined)`.
- **Coverage:** no test calls `deletionFor` or `remove`.

### F2. Medium, baseline race widened by this diff: a stale listing is applied after a save completes
- **Where:** `notes.svelte.ts:285-311` with `draft.svelte.ts:259-265` and `:124-127`.
- **Sequence:**
  1. A watcher or focus refresh lists note A at v1.
  2. An autosave of A is running or starts; the loop is parked in `await readText(raw)` for an earlier-opened raw file (`:307`).
  3. The save lands: `accepted` becomes v2 and `inFlight` clears.
  4. The loop reaches A and calls `observe(present v1)`. No save is running, the versions differ, and the draft is clean, so it adopts v1.
- **Effect:** the buffer reverts on screen and `RichEditor`'s sync drops undo history. The save's own follow-up refresh re-adopts v2. A keystroke in between produces a spurious "changed on disk" conflict against the person's own save.
- **Attribution:** the baseline had this window only across the `Promise.all` of listings, because notes were observed synchronously afterwards. The unified loop now puts N raw-file round trips before note observations. The raw branch has the same race in baseline (read v1, save lands, apply).
- **Fix direction:** extend the identity check you already have. Capture `file.editor.accepted` in the `opened` snapshot (and again just before `readText`), and skip when it changed; the `onSaved` refresh re-observes.

### F3. Low-medium, this diff for raw files, baseline for notes: `retarget` overwrites a retained draft at the destination
- **Where:** `notes.svelte.ts:243`, called from `:453` and `:471`.
- **Sequence:**
  1. A draft at `b.txt` is dirty and its file was deleted on disk, so it is kept with `external: removed`.
  2. The person renames `a.txt` to `b.txt`. The move succeeds because the path is absent.
  3. `openFiles.set(to, file)` replaces the retained `b.txt` draft with no choice offered.
- **Rule broken:** AGENTS.md says "never discarded by … a rename".
- **Attribution:** baseline raw rename did `forget(from)` then `open(to)`, which kept the destination draft. Baseline note rename had the same overwrite via `editors.set`.
- **Fix direction:** refuse the rename when `editorAt(to)` exists.

### F4. Low, this diff: non-text entries are forgotten without the identity check, and `forget` now clears selection
- **Where:** `notes.svelte.ts:290-292`.
- **Identity:** the `openFiles.get(path) !== file` check sits after the non-text branch. A slot replaced during an earlier iteration's await (reopen or retarget) can be forgotten on stale listing data. Hoist the check to the top of the loop body.
- **Selection:** baseline used `openFiles.delete`, which left `selectedPath` set and showed "X is no longer in the folder" (`NotesView.svelte:129-131`). `forget` now clears selection, so a failed or binary view disappears to "No note selected" on the next refresh.
- **Dead-ish UI:** that empty state is now reachable only as a transient flash while a loading selection is being renamed, where its wording is wrong.

### F5. Low, API shape: the runtime allowlist is not tied to the type it claims to mirror
- **Where:** `contract.ts:55-70` versus `platform/types.ts:17-33`.
- **Trigger:** adding a method to `NotesFolder` forces a forwarder in `notes-host.ts` but not an allowlist entry, so it compiles and then faults at runtime with "Not a folder method".
- **Fix direction:** add `satisfies` plus an exhaustiveness assertion on `FOLDER_METHODS`, or derive the `Pick` keys from it.

### Baseline, not this diff
`renameFile` and `renameNoteFile` have no `try`. A transport throw rejects through `FileBrowser.commit` and leaves `committing = true` (`FileBrowser.svelte:154-161`), which makes the name field unusable afterwards.

## Hypotheses challenged

| Hypothesis | Verdict |
|---|---|
| One registry, one `FileEditor` | Holds. Path-based note presentation is sound and keeps editor identity across rename, so `{#key selection.editor}` preserves rich undo. |
| "Accepted retains table metadata needed for table writes" | Overstated. `writeSource` consumes only `path` and `version` (`table.ts:277-304`); nothing reads `accepted.fields`. The union only selects the write route. |
| Loading identity prevents stale opens | Holds. Dedupe is tested; stale-read abandonment is not. |
| Retarget owns rekey and rebase | Holds apart from F3. The boolean "caller must reopen" return is awkward but has three callers; leave it. |
| Serial refresh makes generation counters redundant | Holds. The snapshot-plus-identity check is correct for rename but incomplete for saves (F2) and non-text entries (F4). |
| `patchNote` with explicit save now/later | Holds. The open-editor branch is synchronous up to `input`, so `NoteDetail`'s controlled inputs stay correct. The unopened branch is a conditional `update` with no hidden draft. |
| Bridge exposes only consumed ops, statically coupled | Page side: yes. Host side is still dynamic dispatch behind an untied allowlist (F5). `app<T>` remains caller-asserted, in contrast to the typed `call`. |

## Strongest collapse and its cost

**Draft model: `Draft<SavedText>` only, always writing through `files.write`.**
- Why it is possible: `files.write` and `writeSource` publish the identical conditional change (`folder.ts:235-250`, `table.ts:277-292`), and `saveDraftAsNote` already writes a note through `files.write`.
- Prize: the union, the `'fields' in accepted` switch, and the `tables.notes.writeSource` route.
- Cost: breaks the AGENTS.md rule that note text goes through table operations, and loses the `ownsPath` guard.
- Recommendation: leave it. The prize is about ten lines.

**Bridge: derive from one list.**
- Shape: derive `NotesFolder`'s `Pick` keys from `FOLDER_METHODS` and build the forwarders with a six-line loop and one cast.
- Prize: `FolderCallPath`, `FolderCallMethod` (about 33 lines of conditional types), about 35 forwarding lines, and the type-only cycle between `contract.ts` and `platform/types.ts`.
- Cost: per-call argument and result checking. That checking only guards hand-written forwarding typos; the wire is `decode(...) as T` regardless.
- Recommendation: explicit forwarding is defensible. Do the minimum, which is F5.

No file rearrangement earns its cost; the `bridge/` split of contract, transport and notes-host is right.

## Second read of touched files

| File | Inline / smell | Invariant | API |
|---|---|---|---|
| `notes.svelte.ts` | F1 dead branch; stale docs at `:51` ("A raw file…") and `:528` ("for a note") | F2, F3, F4 | `retarget` boolean return is tolerable |
| `contract.ts` | Type-only cycle with `platform/types.ts` | Allowlist untied (F5) | `BridgeEvent.snapshot` could now be `GitSnapshot`, removing the cast at `notes-host.ts:89` |
| `notes-host.ts` | Stray blank line at `:48` | Git snapshot and stream lifetime are correct | Fine |
| `transport.ts` | Clean rename | Unchanged | `app<T>` untyped |
| `serve.ts` | Stale "KV" at `:11`; blank-line residue at `:214` and `:234` | Removing the staged-authoring guard is safe because the allowlist refuses those paths, and that is tested | Fine |
| `platform/types.ts` | `readonly` dropped from `NotesFolder` members; the tests monkeypatch the folder (`serve.test.ts:968`, `notes.test.ts:154`), which the looser type permits | : | Restore `readonly` and cast in tests |
| `files.ts` | `Pick<FolderFiles,'read'>` is right | : | Fine |
| `NoteDetail.svelte` | `patch` routed through `patchNote` is good | One draft | Fine |
| `DraftStatus`, `RichEditor`, `NoteHistory` | Type rename only | `RichSession.apply`-before-display is untouched | Fine |
| `notes-host.tauri.ts` | Stray blank line at `:8` | Close approval untouched | Fine |
| `README.md` | `:140` still says "tables, KV, or the file browser" | : | : |
| Tests | Good rename and metadata coverage; no delete coverage | : | : |

## Tests that would decide correctness

1. Delete an opened raw text file: `deletionFor` returns `kind: 'file'`, `remove` deletes it, and the draft is forgotten. This fails today (F1).
2. Hold `notes.list` after its read, complete a save of that note, release: `accepted` stays at the saved version, the buffer is unchanged, and `external` is undefined (F2).
3. Rename onto a path that holds a dirty removed-file draft: the rename is refused and both drafts survive (F3).
4. Open a path, then remove or rename it mid-read, then release: the stale read does not resurrect an entry.
5. A type-level assertion that `FOLDER_METHODS` is exhaustive over `NotesFolder` (F5).

## Change versus leave alone

- **Change:** F1 before the native UI recheck; F2's accepted-identity guard; F3's refusal; F4's hoisted check; F5's `satisfies`; the stale comments and blank-line residue.
- **Leave alone:** the registry, the path-based selection, the union draft type, explicit forwarding, the `patchNote` shape, and the serial refresh.

## Unresolved

- F2's real-world frequency is unmeasured. It needs test 2 or a fault-delayed listing during the native recheck.
- Decide whether "X is no longer in the folder" should survive. If so, non-text `forget` should not clear selection; if not, delete the branch at `NotesView.svelte:129-131`.
