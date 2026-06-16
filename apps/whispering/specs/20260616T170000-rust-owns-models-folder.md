# Make Rust the single owner of the models folder

> Revised 2026-06-16. The first draft proposed a *half-move* (give Rust the
> read surface, leave download in JS). A radical-options pass found that the
> half-move pays for a boundary shift without buying a clean story: the folder
> stays touched by both languages and `plugin-fs` stays imported. This revision
> commits to the **maximal** shape: Rust owns the entire models folder, JS owns
> the catalog and the reactive download UI state. See "Why maximal, not the
> half-move" for the reasoning that replaced the original.

## The win in one line

The models folder is the only place in the app read and written in two
languages. Every awkward thing in the local-model code (the `isSymlink`
branching, the dead-link "trust it as-is" bug, the can't-unlink-from-the-UI
wart, the `resolveModelPath` mirror, the duplicated Whisper extension list, the
scattered `mkdir`) is a workaround for one fact: the webview's `plugin-fs` is
scope-bound and cannot follow a symlink whose target lives outside appdata.
Give Rust the whole folder, native and scope-free, and all of it collapses at
once. After this, the boundary is one true sentence: **Rust owns filesystem
truth; JS owns the catalog and the UI.**

## Why maximal, not the half-move

The narrow gap is **symlinks**. Everything else JS already does correctly today:

- **Downloads are valid-by-construction.** `streamModelFile` size-checks the
  staging file *before* `promoteStaging` renames it into place, so a partial
  never reaches the canonical path. A present download is a valid download.
- **Manual drops** (a real file copied into the folder) sit inside `fs:scope`,
  so JS stats them fine; the size check there is load-bearing and works.
- **Links** (external symlink targets) are the *only* thing JS cannot stat or
  delete. Both live "bugs" are this one gap: a dead link reads as installed
  (`hasListedSymlinkEntry` trusts any listed link), and a linked model can't be
  removed from the UI (`deleteModelEntry` rejects an out-of-scope target).

The half-move fixes those by moving *read/list/delete/stat* to Rust but leaves
download/staging/promote in JS on `plugin-fs`. So the folder is still
co-owned, `plugin-fs` stays, and several "collapses" are partial (`download()`
keeps its own `mkdir`). That is the worst spot: boundary cost, no clean story.

Maximal goes one command further and moves download orchestration to Rust too.
That step is cheaper than the first draft assumed, because `download.rs`
**already owns the hard parts**: byte streaming, the cancel registry
(`DownloadManager`), and `Channel` progress. What lives in JS is just
orchestration of those Rust primitives across IPC: per-file staging, the
promote rename, progress re-aggregation, and between-files cancel gating. That
orchestration is on the wrong side of the boundary from the primitives it
drives (and costs N IPC round-trips per multi-file model). Moving it down
co-locates it, deletes `plugin-fs` from this path, and makes the one-sentence
boundary actually true.

### Rejected radical options (named, not hidden)

- **Copy-on-import (delete symlinks entirely).** Would evaporate the whole
  spec with zero new Rust. Rejected: it violates the deliberate "bring your own
  model *without copying bytes*" promise (`model_import.rs:2`); models are
  0.1-3 GB, so a copy doubles disk and is slow.
- **Widen `fs:scope` to link targets at import.** Rejected: scope isn't
  persisted across restart (dead again next launch unless Rust re-scans on
  boot), and it hands the webview broad filesystem read (security regression).

## The design

Rust owns **filesystem truth**: enumeration, symlink resolution, stat, delete,
folder creation, and the full download (stage -> validate -> promote). JS owns
the **catalog** (`constants/local-models.ts`) and the **reactive download UI
state** (`local-model-downloads.svelte.ts`). The seam: Rust reports resolved
facts and runs jobs the catalog describes; JS passes catalog data per call and
keeps the size-validity threshold.

### New / changed Tauri commands

In a new `src-tauri/src/transcription/model_folder.rs` (the JS-facing folder
surface; `model_import.rs` keeps linking, `model_manager.rs` keeps the loader):

- `list_model_entries(engine) -> Result<Vec<ModelEntry { name, linked }>, _>`.
  Rust enumerates and applies the per-engine shape filter it already encodes
  (Whisper: a file/symlink with a `WHISPER_EXTENSIONS` extension; others: a
  directory/symlink). `linked` is display-only ("Your model (linked)"). Kills
  the JS extension list and the JS symlink predicate.
- `delete_model_entry(engine, name) -> Result<(), _>`. Unlinks a symlink
  without touching its target (shares `unlink_symlink` with `model_import`) and
  removes a real entry; succeeds when already gone. Fixes the can't-unlink wart.
- `resolve_model_file_sizes(engine, name, filenames) -> Result<Vec<Option<u64>>, _>`.
  Resolves the entry **through any link** and stats. Empty `filenames` means
  "the entry is itself the file" (Whisper) and returns one element; otherwise
  one element per filename (directory engines). `None` = missing/unstattable.
  JS keeps the threshold (`isModelFileSizeValid`). Serves **both** `isInstalled`
  and the Whisper truncation check, so `resolveModelPath` deletes outright. This
  one command closes the dead-link bug: a dead link stats to `None` -> not
  installed.
- `download_model(engine, entry_name, files, download_id, on_progress) -> Result<(), _>`.
  Orchestrates the whole download natively on top of the existing streaming +
  cancel + `Channel` primitives: `create_dir_all`, stage under
  `{entry}.partial`, stream each file, size-check each against the passed
  catalog size, promote with one rename. A `StagingGuard` removes the partial
  on any error or cancel (its `Drop` runs even when the task is aborted), so
  cancel cleanup is structural, not hand-wired. Progress is cumulative bytes /
  grand total (sum of passed sizes). Replaces the JS download path. The promote
  clears any stale entry through `clear_destination`, which reads the path's own
  type (`symlink_metadata`, never following), so promoting over a colliding
  linked entry unlinks it without touching the user's bytes.
- `reveal_models_folder(engine) -> Result<(), _>`. Creates the engine folder
  and opens it in the OS file manager. Moves the last `plugin-fs` `mkdir` +
  `plugin-opener` call out of the selector.

`download_file` is removed (its only caller was the JS `streamModelFile`).
`link_local_model` stays as-is. `cancel_download` stays.

### What collapses on the JS side

- `local-model-folder.ts` dissolves to thin command wrappers + the size
  comparison: `streamModelFile`, `promoteStaging`, `removeQuietly`,
  `resolveModelPath`, `WHISPER_MODEL_EXTENSIONS`, and all `plugin-fs` /
  `@tauri-apps/api/path` imports go.
- `LocalModelEntry.isSymlink` becomes a display-only `linked` flag from the
  list command; `isInstalled`'s `hasListedSymlinkEntry` special path is gone
  (linked and real installs validate through one path), closing the dead-link
  bug.
- `createModelStorage.isInstalled` becomes: ask Rust for sizes, compare to the
  catalog. `download`/`cancel` become command wrappers (the `Channel` and the
  percent math live in the wrapper; the Svelte machine is unchanged except it
  no longer needs `isCancelled`, since between-files cancel is now in Rust).
- `transcribe.ts` truncation check calls `resolve_model_file_sizes` instead of
  `resolveModelPath` + `stat`; its `plugin-fs` import goes.
- `LocalModelSelector.openModelsFolder` calls `reveal_models_folder`; its
  `plugin-fs` + `PATHS.MODELS` use goes.
- `PATHS.MODELS` has **no remaining JS consumers** and is deleted from
  `fs-paths.ts`. JS no longer knows the engine->folder mapping at all.

### What deliberately stays in JS

- The catalog (`constants/local-models.ts`): URLs, sizes, filenames. Passed to
  `download_model` per call (like `link_local_model` takes its inputs); Rust
  never *stores* it.
- The reactive download state machine (`local-model-downloads.svelte.ts`): the
  `active` re-entry gate, `cancelling`, the computed
  not-downloaded/downloading/ready states. This is UI state, not filesystem,
  and it consumes a `Channel` either way.
- The size-validity threshold (`isModelFileSizeValid`, the 90% rule).

## Risks and open questions

- **Cancel cleanup on task abort.** A `StagingGuard` with a `Drop` that removes
  the `.partial` is the load-bearing mechanism: aborting the tokio task drops
  its future, which drops the guard, which removes the partial. Verify the
  guard is held across every await in the orchestration and disarmed only after
  a successful promote.
- **Early-cancel race.** The JS pre-check (`isCancelled()` after `mkdir`) goes
  away. Preserve it at the same logical point: in the Svelte `download()`,
  after the `isInstalled` await and before calling the command, bail if
  `active.cancelling` is set. The remaining window (set-active -> task-registers)
  is sub-millisecond and already unhandled today.
- **`resolve_model_file_sizes` empty-list contract.** Empty `filenames` = stat
  the entry itself (Whisper). Document it on the command; it's the one subtle
  rule in the seam.
- **Bindings regen.** New + removed commands require `bun run bindings:tauri`,
  then biome-format `bindings.gen.ts` (raw specta is double-quoted/unwrapped
  and produces a ~300-line phantom diff otherwise).
- **Promote over a colliding link (resolved).** If the user linked a model
  named like a catalog model and then downloads that catalog model, the promote
  must replace the link, not follow it. `clear_destination` dispatches on the
  path's own `symlink_metadata`, so it unlinks the collision and leaves the
  link's target intact; a `try_exists` + engine-typed remove would have followed
  the link or failed on it. Covered by a unit test.
- **No behavior change for the happy path.** A downloaded model and a linked
  model must still list, validate, activate, download (with progress + cancel),
  and delete identically. The only intended behavior changes: a linked-but-broken
  entry now reads as not-installed, and a linked entry can be removed from the
  UI.

## Sequencing

Land as one PR with its own review, in dependency-ordered waves:

1. **Rust.** `model_folder.rs` (`list`/`delete`/`resolve_sizes`/`reveal`),
   `download.rs` refactor (`download_model` + `StagingGuard`, drop
   `download_file`), `lib.rs` registration, Rust tests, bindings regen.
2. **JS folder module.** Gut `local-model-folder.ts` to wrappers; rewire
   `createModelStorage`; update the Svelte machine and the truncation check.
3. **Cleanup.** Rename `isSymlink` -> `linked` in the selector/card, delete
   `PATHS.MODELS`, drop now-dead `plugin-fs` imports.

The Rust dedupe (`is_contained_entry_name`) and the collision-toast fix already
shipped separately, as down payments on the same direction.
