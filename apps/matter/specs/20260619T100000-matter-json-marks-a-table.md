# matter.json marks a table: matter becomes a declared store

- **Status:** In Progress

Implements [ADR-0029](../../../docs/adr/0029-matter-json-marks-a-table.md) and
[ADR-0030](../../../docs/adr/0030-references-resolve-within-a-folder-and-its-immediate-children.md).
Replaces the deleted full-collapse spec and the "altitude is pure shape"
direction.

> Note: the `20260619T100000` timestamp is hand-set; adjust to the real creation
> time if it matters.

## The model

A folder is a table **iff it contains a `matter.json`**. matter never guesses
from shape.

- Marked folder → its `.md` are rows.
- Marked immediate child folders → subtables (nesting is first-class).
- Unmarked folder → not data; ignored (attachments, junk, organizational dirs).
- **Opening `F` shows:** `F`'s own rows (if `F` is marked) + its immediate marked
  children as subtables. No recursion; descend by opening a subtable. `F` need
  not be marked for its marked children to show.

## Contract semantics (the one behavior change at the parse boundary)

Grounded in current code (`src/lib/core/table.ts`, `contract.ts`):

| `matter.json` | today | after |
|---|---|---|
| absent | untyped table (`kind:'none'`) | **not a table** |
| `{}` | `MissingFields` **error** | **untyped table** (raw grid) |
| `{"fields":{}}` | typed, zero fields | typed, zero fields (unchanged) |
| `{"fields":{...}}` | typed | typed (unchanged) |
| unparseable | untyped + error | **`invalid-contract`** (a claimed but broken table) |

So: drop the `MissingFields` error; `{}` (no `fields` key) means untyped raw
grid; absence means "not a table." `{}` is the canonical untyped marker and the
cheapest thing an "adopt folder" action can write.

## Discovery and reference scope

- A folder is a table iff `readContractText(dir) !== undefined`.
- `loadPath(F)` returns the tables in `F`'s scope: `[F (if marked), ...immediate
  marked children]`. Unmarked children are skipped (one `matter.json` stat each;
  no tree-walk).
- References (ADR-0030) resolve within that one scope, by bare name, no
  cross-level. The deleted `scope: 'table' | 'vault'` becomes `tables.length ===
  1` (lone table → cross-refs unevaluable; with marked children → missing target
  is dangling).

## Deletion prizes

- `scope: 'table' | 'vault'` on `LoadedPath` and in the CLI `--json`.
- The `hasChildTable ? loadVault : loadTable` branch in `loadPath` and the
  mirrored altitude special-case in `scan_vault`.
- The `MissingFields` contract error (`{}` is now valid).
- The whole shape-guessing ambiguity class: table-vs-vault, row-vs-document,
  table-vs-attachment, and the silent `.md`-drop footgun.
- The `fs.test.ts` / `watch.rs` cases that pinned shape-based altitude.

## Code changes by file

- `src/lib/core/table.ts` — `loadContract`/`validateContract`: `{}` and any
  no-`fields` object → untyped (not error); remove `MissingFields`. `buildView`
  untyped path now reached only for marked-but-fieldless folders.
- `src/lib/load/fs.ts` — `loadPath` returns marked self + marked children; drop
  `LoadedPath.scope` (return `TableInput[]`). `loadVault` becomes "load marked
  immediate children" (skip folders without `matter.json`); tolerate an
  unreadable root by returning `[]`.
- `src/lib/core/integrity.ts` — `assessTable`: an unmarked folder never reaches
  here as a table; `untyped` remains valid (now = marked, fieldless).
- `src/cli/check.ts` — replace `scope === 'table'` with `tables.length === 1`;
  drop `scope` from `writeJson`. Pointing `check` at an unmarked folder with no
  marked children is "no tables here," not an untyped pass.
- `src/lib/table.svelte.ts` — `matter.json` removed at runtime now means the
  folder stops being a table (not "degrade to raw view").
- `src-tauri/src/watch.rs` — `scan_vault` lists immediate children that contain
  `matter.json` (+ root itself if marked); watcher must observe `matter.json`
  create/delete to keep the subtable list live (see Open).

## Migration

- Add `missing-model/matter.json` = `{}` so it stays an untyped table; keep its
  test asserting "untyped." Add a new fixture/test: a folder with no
  `matter.json` is **not a table**.
- Example vaults: no change (all tables already declare `fields`;
  `content-vault/README.md` at the unmarked root is correctly ignored, and
  `loadPath(content-vault)` still yields the 3 marked tables).

## Wave order

1. **Contract + loader (TS): DONE.** `{}` → untyped, removed `MissingFields`
   (`parseContract` now classifies typed/untyped/error); marker rule in
   `loadPath`/`loadVault`; dropped `scope` (`loadPath` returns `TableInput[]`).
   Shape-based loader tests inverted to the marker/nesting model.
2. **Integrity + CLI + fixtures: DONE.** `check.ts` uses `tables.length === 1`;
   `--json` dropped `scope`; `missing-model` migrated to a `{}` marker;
   `not-a-table` fixture + "no tables here" test added. `integrity.ts` needed no
   change: the loader filters unmarked folders out, and the `untyped` path was
   already valid. (Waves 1+2 landed together because dropping `LoadedPath.scope`
   forces the `check.ts` change in the same green step.)
3. **Watcher (Rust):** `scan_vault` marker rule + live `matter.json`
   create/delete detection; mirror tests in `watch.rs`. The live vault
   (`vault.svelte.ts` → `watch_vault`) still uses the old shape rule until this
   wave; the CLI/pure-TS path is already on the marker rule.
4. **UI:** render subtables (nesting navigation) + an "adopt folder as table"
   action that writes `{}`.

## Open questions

- **Watcher live-detection depth.** Root watcher is non-recursive, so a child
  gaining/losing `matter.json` won't auto-flip the subtable list. V1: rescan on
  open. Better: watch one level deeper for `matter.json` only.
- **UI nesting render** (tabs vs left-hand tree that expands) — defer to a
  co-design pass before Wave 4.
- **Skip dot-`.md` as rows?** Would give a `README` inside a marked table an
  escape from becoming a row. Minor; decide in Wave 1.
- **`{}` vs `{"fields":{}}`.** `{}` = untyped raw grid; `{"fields":{}}` = typed
  with zero declared fields. Both valid and distinct; keep both.
