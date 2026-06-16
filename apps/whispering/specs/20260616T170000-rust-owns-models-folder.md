# Make Rust the single owner of the models folder

## The asymmetric win in one line

Today the models folder is read from two places in two languages: the webview
(`local-model-folder.ts`, via `plugin-fs`) and Rust (`model_manager.rs` /
`model_import.rs`, natively). The webview's `fs:scope` cannot follow a symlink
whose target lives outside appdata, and almost every awkward thing in the local
model code is a workaround for that one limitation. Give Rust the read surface
too, and the `isSymlink` branching, the `resolveModelPath` mirror, the
duplicated Whisper-extension list, and a latent correctness bug all collapse at
once.

## Why this is the right altitude (grounding)

The split, concretely:

- **Rust already owns** the loaders (`model_path_for` in `model_manager.rs`),
  link creation and shape validation (`link_local_model` in `model_import.rs`),
  and the folder-name contract (`engine_models_dir`, `is_contained_entry_name`,
  `parse_moonshine_variant`). Rust reads the folder natively, so it follows
  symlinks fine.
- **The webview also reads the folder** in `local-model-folder.ts`:
  `listModelEntries` (`readDir` + extension/dir/symlink filter),
  `deleteModelEntry` (`readDir` + `remove`), `resolveModelPath` (path math), and
  `createModelStorage.isInstalled` (`stat` + per-file size checks). It reads
  through `plugin-fs`, which is scope-bound.

Because the webview cannot stat through an external symlink, the JS code carries
a running tax:

- `LocalModelEntry.isSymlink` exists only to branch on this. `listModelEntries`
  has a separate symlink predicate; `isInstalled` early-returns `true` for any
  listed symlink and **"trusts it as-is, never size-validates"**
  (`local-model-folder.ts:341-343`, `hasListedSymlinkEntry`); `deleteModelEntry`
  carries a symlink-only error string (`local-model-folder.ts:169-171`).
- That trust is a **latent correctness bug, not just clutter**: a linked model
  whose target was moved or deleted still reports installed, because JS can't
  stat the dead link. Rust following the link would catch it. This is the single
  strongest reason to do the move; it is a fix, not only a tidy.
- `WHISPER_MODEL_EXTENSIONS` (`local-model-folder.ts:74`, with dots) duplicates
  `WHISPER_EXTENSIONS` (`model_import.rs:27`, without dots). Two edit sites for
  one fact; the Rust comment already admits the mirror.
- `resolveModelPath` is explicitly "the JS mirror of Rust's `model_path_for`"
  and has exactly one consumer: a Whisper truncation `stat` in
  `transcribe.ts:234`.

## The design

Rust owns **filesystem truth** (enumeration, symlink resolution, stat). JS keeps
the **catalog** (`constants/local-models.ts`) and the **size-validity policy**,
because expected sizes are app data that has no business in Rust. The seam is:
Rust reports resolved facts; JS compares them to the catalog.

New / changed Tauri commands:

- `list_model_entries(engine) -> Vec<ModelEntry { name, linked }>` replaces the
  JS `readDir` + filter. Rust applies the same per-engine shape filter it
  already encodes, and reports `linked` for display only ("Your model
  (linked)"). Kills the JS extension list and the JS symlink predicate.
- `delete_model_entry(engine, name) -> Result<()>` replaces the JS
  `readDir`/`remove`. Rust unlinks a symlink without touching its target (it
  already does this for re-linking in `clear_link_path`) and removes a real
  entry, so the symlink-specific error message disappears.
- For `isInstalled`, Rust resolves the entry **through any link** and returns the
  real files and sizes; JS keeps the catalog-size comparison
  (`isModelFileSizeValid`). Smallest viable shape: a command that, given an
  engine + entry name + the expected filenames, returns each file's resolved
  size or "missing." JS owns the threshold, Rust owns the stat.

`link_local_model` stays as-is.

### What collapses

- `LocalModelEntry.isSymlink` stops being a branching invariant. At most it
  survives as a display-only `linked` flag returned by the list command.
- `isInstalled`'s `hasListedSymlinkEntry` special path is gone; symlinked and
  real installs validate through one code path (the link is resolved before the
  size check), which closes the dead-link bug.
- `resolveModelPath` is deleted; the `transcribe.ts` truncation `stat` moves
  behind a Rust call (or is dropped if Rust's load-time check already covers it,
  worth confirming).
- The JS `WHISPER_MODEL_EXTENSIONS` copy is deleted; Rust's `WHISPER_EXTENSIONS`
  is the single source.
- The scattered defensive `mkdir(..., { recursive: true })` (every `download()`,
  `link_local_model`, `openModelsFolder`) centralizes naturally once Rust owns
  folder creation.

### What deliberately stays in JS

The download streaming / staging / promotion path (`streamModelFile`,
`promoteStaging`, `removeQuietly`) and the cancel state machine
(`local-model-downloads.svelte.ts`, the `active` re-entry gate). It is
well-factored, the cancellation reasoning is careful, and progress is wired
through reactive `Channel` updates the UI consumes directly. Moving it to Rust
is a lateral move, not a simplification, and is out of scope here.

## Risks and open questions

- **The size-validation seam is the real design decision.** Keep the catalog and
  the threshold in JS (recommended): Rust returns resolved sizes, JS decides
  valid/invalid. The alternative (move catalog sizes into Rust) drags app data
  across the boundary and is the wrong trade.
- **Per-file stat round-trips.** `isInstalled` for a multi-file engine currently
  stats each file. Batch it into one command (return all file sizes at once)
  rather than one invoke per file.
- **`transcribe.ts:234` truncation check.** Confirm whether Rust's load-time
  validation already rejects a truncated Whisper file; if so, the JS pre-check
  (and the last reason `resolveModelPath` exists) can be deleted outright rather
  than ported.
- **Bindings regen.** New commands require `bun run bindings:tauri`, then
  biome-format `bindings.gen.ts` (raw specta output is double-quoted/unwrapped
  and produces a ~300-line phantom diff otherwise).
- **No behavior change for the happy path.** A downloaded model and a linked
  model must still list, validate, activate, and delete identically; the only
  intended behavior change is that a linked-but-broken entry now reads as
  not-installed instead of installed.

## Why not now / sequencing

This is a distinct piece of work from the collision-toast fix it grew out of: a
real Rust command surface, retiring tested JS, and a bindings regen. It should
land as its own PR with its own review, not ride along with a copy change. The
small Rust dedupe (`is_contained_entry_name`) already shipped separately and is
a down payment on the same "Rust is the source of truth for the folder
contract" direction.
