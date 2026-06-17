# Vault as the Relational Unit (`apps/matter`)

**Date**: 2026-06-16
**Status**: Proposed (greenfield direction; compatibility pressure explicitly released by the owner). Revised once to fold conformance and references into one composed integrity model; revised again (grilling pass) to make that composition return ONE rich structure every surface selects from, to give tables four honest states, and to scope Wave 2 to full pipeline unification.
**Owner**: Braden
**Branch**: feat/field-reference-kind
**Depends on**: the reference field kind (`packages/field`), `checkReferences` (`src/lib/check/references.ts`), per-table conformance (`src/lib/core/conformance.ts`), the per-folder watcher (`src-tauri/src/watch.rs`), and the SQLite mirror (`src/lib/core/sqlite.ts` + `src-tauri/src/mirror.rs`), all already shipped or in flight on this branch.

## One Sentence

Promote the **Vault** (a directory of typed markdown tables) to Matter's primary object so references resolve live across a real on-disk vault instead of in a fixtures-only demo, renaming today's single-folder "vault" to **Table**, moving the watched and queried unit up one level from the folder to its parent, and reporting schema, row, and reference problems through **one composed integrity vocabulary**.

## How to read this spec

```
Read first:        One Sentence · The Core Insight · Product Sentence · Target Shape
Read for design:   Integrity Model · Naming Map · Ownership Pass · Refusals · Architecture
Read to execute:   Call Sites · Implementation Plan · Edge Cases · Success Criteria
Read for taste:    Open Forks (the decisions that are the owner's, not the code's)
```

Two load-bearing decisions: the **primitive promotion** (folder to vault) and the **one integrity report composed from two pure primitives**. Every rename, file move, and the SQLite relocation are downstream of the first; the report vocabulary is downstream of the second.

## Motivation

### The symptom

Opening `examples/matter/content-vault` in the live app shows "1 rows, 0 columns, no model for this folder." The user expected the three modeled tables (`pages`, `adaptations`, `publications`) or the Notion-like reference view. Instead they got the raw, unmodeled grid over the one stray file at that level (`README.md`).

That is not a bug in the watcher or the model layer. It is the architecture working exactly as designed: Matter watches **one folder as one table**, non-recursively (`watch.rs`: `scan` skips anything that is not `is_file()`), and `content-vault/` is a *container of table-folders*, with no `matter.json` of its own. The pieces are all correct. The **top-level primitive is at the wrong altitude.**

### The disease

References are the headline feature of this branch. A reference (`adaptations.page = "become-the-source"`) only has meaning across **two tables in the same vault**. But the app's primary object is a single folder/table, so the feature has nowhere to live in the real app. It survives only in `/demo/references`, which **reimplements** the multi-table view over **inlined fixtures** (`references-fixtures.ts`) because the live pipeline cannot load a directory of tables.

Three consequences, all from the one wrong primitive:

1. **References are demo-only.** The validator (`checkReferences`) runs in a CLI script and an in-memory demo, never over the live disk vault.
2. **`content-vault` is unopenable.** The thing the example is *named for* is a category error to open.
3. **"Vault" is overloaded.** `createVault(path)`, `Vault`, `FolderGridVault`, `OpenVault`, `open-vaults`, `/vault/[id]`, and the dialog title "Open vault folder" all bind "vault" to "one folder = one table," which is the wrong meaning for a word the example reserves for the whole relational set.

### The second, quieter problem

Matter has **two unrelated report vocabularies** for what a user experiences as one question ("what is wrong with my data"):

- `CheckReport` / `FatalCheckReport` (`check/report.ts`): single-folder conformance, with `summary` counts, `byField` stats, `extras`, and a separate fatal axis (`MODEL_INVALID`, `FOLDER_UNREADABLE`).
- `ReferenceReport` (`check/references.ts`): cross-folder, with `MISSING_TARGET` and `UNRESOLVED` findings.

A user wants one answer, scoped to the thing they opened. That is a second, independent reason the folder-level primitive is wrong: integrity is inherently a vault-level question.

## The Core Insight

Matter is a tool that treats a **directory tree of markdown as a typed, relational, queryable database**, where the filesystem is the source of truth and the schema travels with the data (per-folder `matter.json`). It already has every capability: typed columns (conformance), SQL queries (the mirror), and relations (references). It just chose the folder, not the folder's parent, as the unit the user opens, watches, and queries. Lifting that one choice makes references first-class, makes `content-vault` correct, and lets one integrity report answer the whole "what is wrong" question.

## Product Sentence

> A **Vault** owns a directory of typed markdown **Tables**. The app enters through one Vault and resolves **references** across its Tables. Each Table's `matter.json` owns its own **contract**; the filesystem owns every **Row**. One **integrity** report, composed from per-table conformance and cross-table reference resolution, answers what is wrong.

Everything below is judged against this sentence. If a path, branch, type, or helper survives the sentence being true, it is removable.

## Target Shape

### The object model

```
Vault    a directory the user opens. Owns the set of Tables discovered beneath it,
         one SQLite mirror, and the live integrity report across its Tables.
         (was: the parent of `content-vault`, a concept the app had no name for)

Table    one folder of markdown. Owns its rows and its optional matter.json contract.
         A modeled Table has a typed schema; an unmodeled Table is a raw frontmatter grid.
         (was: "vault" / createVault / FolderGridVault)

Row      one .md file. fileName + stem + frontmatter + body. Identity is the stem;
         no id is minted. (unchanged)

Contract the matter.json in a Table folder: that Table's column schema, self-describing
         and portable. (was: "model"; standardize on "contract", which the UI copy already uses)

Reference a field whose value is a target Row's stem in another Table of the same Vault.
         Resolution is a Vault-level operation. Dangling is a surfaced state, never repaired.
         (unchanged storage: a plain stem string)
```

### The runtime composition

`createVault(rootPath)` composes, it does not reimplement:

- A shallow (depth-1) watch on `rootPath` to detect Table folders appearing and disappearing (a folder gains/loses a `matter.json`, a folder is added/removed).
- For each child folder, a `createTable(folderPath)` instance: today's `createVault` body, renamed, essentially unchanged. It already is a clean single-folder primitive (one store, one `applyDeltas` path, `whenReady`, `dispose`).
- The Vault owns disposal of its Tables: dispose the Vault, dispose every Table watch and the root watch.

The Vault is the **live union of its Tables' self-declared contracts**. It declares nothing itself. Discovery, not declaration.

### The demo collapses into reality

`/demo/references` stops being a second implementation. "Demo" becomes **"open the bundled `examples/matter/content-vault` as a Vault."** The Notion-like relation view (table switcher, reference chips colored by verdict, the integrity panel) becomes the **real Vault view**, driven by the real `readFolder` + integrity pipeline. Delete `references-fixtures.ts` and the inlined `createReferencesDemo`. One view, one code path, both the example and a user's own vault flow through it.

### The SQLite mirror goes per-Vault (the sleeper win)

Today each folder writes its own `matter.sqlite`. Move it to **one database per Vault, one SQL table per folder.** This makes the operation that is impossible today possible:

```sql
SELECT p.file, a.title
FROM publications p
JOIN adaptations a ON a.stem = p.adaptation
```

References stop being a bolt-on validator and become **actual relational joins** over the vault. The `WHERE` filter (`matchingFileNames`) generalizes from one table to "the active table in the vault." The projector (`projectToSqlite`) already builds per-table SQL; it gains a vault-level orchestrator that rebuilds the whole db (still a full DROP + CREATE + INSERT, still a pure function of disk, still self-healing).

### Routes and UX

```
/                 onboarding: open a Vault (a directory). One tab is one Vault.
/vault/[id]       the Vault shell: a Table switcher (sidebar/tab strip), the active
                  Table's grid (today's FolderGrid), and a live Integrity panel.
                  (the demo's three-table layout, but over the real vault)
(removed)         /demo/references as a separate fixtures view. The bundled example
                  vault is reachable as a normal Vault; keep one onboarding entry that
                  opens it through the real pipeline.
```

The single-Table case is a degenerate Vault (one Table). The "no model" state stops being a dead-end banner and becomes an **untyped Table** in the vault, still listed, still a valid reference target (stems exist regardless of contract).

## Integrity Model

> **Revised 2026-06-16 (grilling pass; compatibility released by the owner).** The first draft
> made the composition return a flat `Violation[]` and kept `CheckReport` alive beside it. That
> reproduces the very "two report vocabularies" problem this spec opens by diagnosing: after it,
> conformance would be walked THREE times (`CheckReport`, the violation list, and the grid's own
> reference-chip pass in `references-demo`), each free to drift. A flat list also cannot drive
> the grid (it has to re-index findings against rows to color a chip). This revision makes the
> composition return ONE rich structure that every surface SELECTS from.

Keep `conformance` and references as two pure primitives; let `assess` compose them. The reason
to keep them separate is **timing, not taste**: conformance is computable the instant ONE folder
is read (a single open table must render from it before any vault exists), while reference
resolution is a strictly LATER refinement that needs sibling tables to have loaded. `assess` is
the point where the later data, once present, refines the earlier classification.

### The one structure: `VaultIntegrity`

`assess(tables)` returns an indexed structure rich enough to render a cell and, after one
projection, flat enough to summarize. The grid, the integrity panel, the CLI, the `--json`
output, and the exit code are all PURE SELECTORS over it. One walk over the classification, so
two surfaces cannot disagree.

### The cell IS the view-model

Reference resolution is not a separate report; it is a richer cell state. Conformance (no vault
knowledge) can only call a present, valid reference string `ok`. `assess` REFINES that single
`ok` into `resolved | dangling | missing-target`, and a `resolved` cell carries the target row
so a chip renders its title with no second lookup. So `cell.state` is the complete widget
selector: one exhaustive switch, no component touching the vault or a findings list.

```ts
type AssessedCell =
  // non-reference cells, plus the "absent / wrong" states shared with references
  | { field: Field; state: 'ok';               value: unknown }   // present, valid, non-reference
  | { field: Field; state: 'missing-required' }
  | { field: Field; state: 'missing-optional' }
  | { field: Field; state: 'invalid';          raw: unknown }
  // reference cells, present & valid: the refinement of a transient `ok`
  | { field: Field; state: 'resolved';       value: string; target: string; targetRow: Row }
  | { field: Field; state: 'dangling';       value: string; target: string }
  | { field: Field; state: 'missing-target'; value: string; target: string };
```

`ok` is exclusive to non-references; `resolved`/`dangling`/`missing-target` are exclusive to
references; `missing-required`/`missing-optional`/`invalid` are SHARED (a required reference can
be absent, an optional one too, a reference value can be a non-string). `MISSING_OPTIONAL` and
`ok` never appear in the violation projection, which proves that list is a projection of the
cells, not all of them.

`conformance.ts` does NOT move and its tests stay green: it keeps producing the four-state
`Cell`. `assess` owns the `Cell -> AssessedCell` widening, replacing a reference cell's transient
`ok` with the verdict and passing everything else through unchanged.

### Tables have four honest states; strictness is a report policy

A table's status is a discriminated union with four states, NOT a `loaded | fatal` binary.
**`unmodeled` (no `matter.json`) is a VALID state, never a failure**: the live grid already shows
it as a raw, type-less grid, and it is still a valid reference target (existence is the file
existing, contract or not). The first draft's `MODEL_MISSING`-as-fatal made the same folder
"fatal" to the CLI and "fine" to the app; this kills that contradiction.

```ts
type TableAssessment =
  | { name: string; status: 'unreadable';       message: string }                 // folder could not be read
  | { name: string; status: 'invalid-contract'; message: string }                 // matter.json present but corrupt/unrecognized
  | { name: string; status: 'unmodeled';        rows: Row[]; columns: string[] }  // raw grid, valid
  | { name: string; status: 'modeled';          contract: Contract; rows: RowAssessment[] };

type RowAssessment = { row: Row; cells: AssessedCell[]; extras: Extra[] };

type VaultIntegrity = { version: 1; tables: TableAssessment[] };
```

`unreadable` and `invalid-contract` are genuine failures, split by cause the way reference
findings split `missing-target` from `dangling` (different cause, different fix). A failed OR
`unmodeled` table contributes no `modeled` cells and turns every inbound reference into
`missing-target` (the honest causal chain), but every table in ALL four states still contributes
its file stems to the reference existence index.

### The projections (pure selectors, no re-derivation)

```ts
toViolations(v: VaultIntegrity): Violation[]   // cells where state ∈ {missing-required, invalid, dangling, missing-target},
                                               // located by table/row/field; missing-target deduped to once per column.
summarize(v: VaultIntegrity): Summary          // per-table + total: ready / needs-attention / unreadable / untyped counts, byField.
```

`Violation` is the flat, located shape for the panel, the CLI, and `--json`; `tierOf(v)` derives
`table | row | cross-table` from `kind`, never stored.

```ts
type Violation =
  | { kind: 'missing-target';     table: string;             field: string; target: string }
  | { kind: 'missing-required';   table: string; row: string; field: string }
  | { kind: 'invalid-type';       table: string; row: string; field: string; raw: unknown }
  | { kind: 'dangling-reference'; table: string; row: string; field: string; value: string; target: string };
```

`Extra` keys (frontmatter not in the contract) ride on `RowAssessment`, are never violations, and
project as notes. The grid never calls `toViolations`; it binds `tables[i].rows[j].cells[k]`
directly, so the panel and the grid are consistent by construction (same cells).

### `expected` is a render projection, not data

The first draft put `expected: ExpectedValue` inside the `invalid-type` violation, which forced
`core/integrity` to import display plumbing from the old `check/` module: a new-depends-on-old
inversion. Refused. "What did this field expect" is a RENDERING concern. The `invalid`/
`invalid-type` shape carries enough to identify the field; `describeExpected(field): ExpectedValue`
(serializable) and `formatExpected(ExpectedValue): string` (human text) live in the `report/`
layer. `core` never imports them. They appear only in the SERIALIZED violation (`--json`) and the
formatted text, computed at the edge.

### CLI scope follows the path

`matter check <path>` infers scope from the path: a table folder yields a one-table vault
(reference fields noted as un-evaluable in isolation), a parent of table folders yields the full
vault. One pipeline, scope inferred by the loader. `unmodeled` exits 0 with a note;
`invalid-contract` and `unreadable` exit non-zero. No `--strict` / `--require-contract` flag until
a concrete CI gate earns it (see Refusals).

## Naming Map (old to new)

```
createVault(path)        -> createTable(path)            single-folder watcher (the body barely changes)
Vault (the type)         -> TableHandle                  ReturnType of createTable (a handle with methods, not data)
FolderGridVault          -> TableView                    the Pick<> boundary the grid renders from
src/lib/vault.svelte.ts  -> src/lib/table.svelte.ts      the watcher primitive's home
createDemoVault          -> createDemoTable               (deleted entirely in Wave 4 with the demo)
createReferencesDemo     -> (deleted)                    folded into the real Vault view
OpenVault {id,path,name} -> OpenVault {id,root,name}     a tab is a vault root, not a folder (Wave 3)
open-vaults.svelte.ts    -> (kept, semantics lifted)     list of open VAULT ROOTS (Wave 3)
/vault/[id]              -> /vault/[id]                   now resolves to a Vault root, renders the shell (Wave 3)
"model" (matter.json)    -> "contract"                   one word, the UI copy already says "contract"
core/folder.ts           -> core/table.ts                LoadedTable, buildView, readTable (Wave 3, NOT Wave 2)
"model" type/file        -> "contract" (Contract)        model.ts -> contract.ts (Wave 3, with the folder rename)
LoadedFolder {table,read}-> LoadedTable {name,read}      defined in core/references.ts over FolderRead (Wave 2; re-homes to core/table.ts in Wave 3)
checkReferences()        -> resolveReferences(tables)    pure primitive over CLASSIFIED tables, moved to core/references.ts (Wave 2)
matter.sqlite (per dir)  -> matter.sqlite (per vault root) one db, one table per folder (Wave 5)
check/ (dir)             -> report/ (dir)                projections for the outside world: violations.ts, expected.ts, format.ts, exit-code.ts (Wave 2)
CheckReport/FatalCheckReport -> (deleted)                replaced by VaultIntegrity + toViolations + summarize (Wave 2)
check/check.ts reportFromRead -> (deleted)               the single-folder re-derivation; CLI runs assess + project instead (Wave 2)
ExpectedValue/describeExpected -> report/expected.ts     render projection, NOT in the core data (Wave 2)
(new)                    -> core/integrity.ts            assess(tables) -> VaultIntegrity, composing conformance + references (Wave 2)
(new)                    -> core/vault.ts                LoadedVault: ordered tables + reference scope (Wave 3)
(new)                    -> load/fs.ts                   Node loader: dir/vault root -> LoadedTable[] (Wave 2; absorbs cli/check readInput + the script's loaders)
(new)                    -> load/tauri.ts                the reactive watcher home (Wave 3)
(new)                    -> createVault(rootPath)        composes tables + root discovery watch (Wave 3)
```

The runtime handle is `TableHandle` and the grid boundary is `TableView`, deliberately: **there is no bare `Table` data type**, so it never collides with `import * as Table from '@epicenter/ui/table'` in the grid components.

## Ownership Pass

```
selected vault       URL (/vault/[id]) + open-vaults list      which root is open
selected table       URL query or vault UI state               which table is active in the shell
table rows           the filesystem (the .md files)            durable product facts
table contract       that folder's matter.json                 self-describing, portable schema
per-cell state       core/conformance.ts (per table)           the grid's per-row render model
reference resolution core/references.ts (per vault)             stems becoming links, the cross-table answer
integrity report     core/integrity.ts (composes the above)    the one "what is wrong" vocabulary
vault membership     the Vault's root discovery watch           which folders are tables right now
sqlite mirror        the Vault (one db, full rebuild)           the external relational read surface
table watch lifetime the Vault (composes + disposes tables)     no table outlives its vault
```

No value has two owners. Conformance and references each own their own answer; integrity owns only the *composition and projection*, not the answers themselves.

## Refusals

Greenfield discipline is also about what we refuse to add.

```
Candidate:  Merge conformance and references into one integrity() function.
Refusal:    They have different scopes (one table vs the vault) and different outputs (full cell-state
            model vs reference findings). Conformance's OK/MISSING_OPTIONAL states feed the grid and are
            not violations. integrity() composes the two pure primitives and projects to Violation[];
            it does not absorb them.
User loss:  None; the user still gets one report. The primitives stay independently testable and the grid
            keeps its render model.
Decision:   Refuse the merger. Compose.
Trigger:    None foreseen.
```

```
Candidate:  A central vault-level schema file (one matter.config declaring all tables + relations).
Refusal:    Per-folder matter.json is the right unit. A folder + its contract is self-contained and
            portable: hand someone `pages/` and the schema travels with it. The Vault discovers and
            composes; it declares nothing.
User loss:  No single-file view of the whole schema; the relation graph is implicit in x-ref markers.
Decision:   Refuse. Discovery over declaration.
Trigger:    Revisit only if a vault needs a relation that no source table can declare on its own field
            (e.g. a many-to-many join table with its own attributes).
```

```
Candidate:  Mint a stable Row id and reference by id instead of by stem.
Refusal:    Stem-string references are the wikilink primitive: human-authored, readable, the form an
            author already writes in frontmatter. The fragility (rename target -> dangle) is exactly
            what the integrity report surfaces. Minting ids fights "no id is minted, the file is identity"
            and makes files less hand-authorable.
User loss:  Renaming a target file dangles its inbound references (caught, not silent).
Decision:   Refuse. References stay plain stems.
Trigger:    Revisit only if a non-human writer becomes the primary author of these files.
```

```
Candidate:  A reference resolver / auto-fixer that repairs dangling references on read.
Refusal:    Dangling is a surfaced state, never silently repaired. Repair code in a read path is a known
            smell; the integrity report reports, it does not mutate.
User loss:  None; reporting is the product behavior.
Decision:   Refuse.
Trigger:    None foreseen.
```

```
Candidate:  Keep /demo/references (fixtures) alongside the real Vault view.
Refusal:    Two ways to do one thing. The fixtures exist only because the live pipeline could not load a
            vault; once it can, the example vault IS the demo.
User loss:  The demo no longer runs with zero filesystem; it needs the bundled example on disk (committed).
Decision:   Refuse the duplication. Collapse to the real view over the example vault.
Trigger:    If a pure-memory harness is ever needed for tests, the pure readFolder + resolveReferences
            functions already serve that without a route.
```

```
Candidate:  Make assess() return a flat Violation[] (IntegrityReport) as its primary output.
Refusal:    A flat list cannot drive the grid (it must re-index findings against rows to color one
            chip), so the grid keeps a SECOND walk and the two can drift. assess() returns the rich
            VaultIntegrity; the violation list is one pure selector (toViolations) over it. Same one
            report the user sees; one walk; surfaces consistent by construction.
User loss:  None. The flat list still exists, as a projection.
Decision:   Refuse the flat-primary. Rich source + selectors.
Trigger:    None foreseen.
```

```
Candidate:  Carry expected: ExpectedValue inside the violation data (so core/integrity owns it).
Refusal:    "What did this field expect" is a render concern; baking it into the data forces the new
            core to import display plumbing from the old check/ module (new-depends-on-old). The
            invalid cell carries its field; describeExpected/formatExpected live in report/ and run
            at the edge (serialized JSON + human text).
User loss:  None. --json still carries expected, computed in the projection.
Decision:   Refuse data-resident expected. Project at the edge.
Trigger:    None foreseen.
```

```
Candidate:  Treat an unmodeled folder (no matter.json) as a fatal/failure state in core, and/or add
            --strict / --require-contract to matter check now.
Refusal:    Unmodeled is a VALID state (the live grid shows it as a raw grid; it is still a reference
            target). Making it fatal recreates the app-vs-CLI contradiction this spec set out to fix.
            matter check reports it as a note and exits 0. The strict flag has no consumer yet (earned-
            trigger test), so it is not built.
User loss:  None today. No CI gate currently needs strict certification.
Decision:   Refuse fatal-unmodeled and the premature flag.
Trigger:    Build --require-contract when a real CI pipeline needs to fail on untyped folders.
```

## Architecture

### File moves (TypeScript)

```
src/lib/table.svelte.ts                 (was src/lib/vault.svelte.ts)
  createTable (was createVault); TableHandle (was Vault); TableView (was FolderGridVault).
  Body is largely unchanged: it is already a clean single-folder watcher.
  In Wave 5, drop the per-folder mirror call; the Vault orchestrates the mirror.

src/lib/vault.svelte.ts                  (new, Wave 3)
  createVault(rootPath): composes createTable per child folder + a root discovery watch;
  owns the per-vault SQLite mirror rebuild and the live integrity() derived.

src/lib/core/parse.ts                    Markdown -> Row { stem, fileName, frontmatter, body }.   [unchanged]
src/lib/core/folder.ts                   readFolder, FolderRead, buildView, loadModel.    [unchanged in W2; -> core/table.ts + model->contract in W3]
src/lib/core/conformance.ts              pure per-table cell classification (4-state Cell).        [unchanged primitive; W2 must NOT touch it]
src/lib/core/references.ts               was check/references.ts. resolveReferences(tables) — pure, over classified tables.  (W2)
src/lib/core/integrity.ts                new (W2). AssessedCell / TableAssessment / RowAssessment / VaultIntegrity; assess(tables)
                                         composes conformance (Cell -> AssessedCell widening) + resolveReferences.
src/lib/core/vault.ts                    new (W3). LoadedVault = ordered LoadedTable[] + the reference scope.
src/lib/core/sqlite.ts                   projectToSqlite stays per-table; add a vault-level rebuild (one db).  (W5)

src/lib/report/                          new (W2), was check/. Pure selectors over VaultIntegrity:
  violations.ts                            toViolations, summarize, tierOf, Violation.
  expected.ts                              ExpectedValue, describeExpected (serialization of "what was expected").
  format.ts                                formatExpected + human text (was check/format.ts).
  exit-code.ts                             (was check/exit-code.ts).
src/lib/check/                           DELETED (W2): check.ts, report.ts (CheckReport/FatalCheckReport), references.ts.

src/lib/load/fs.ts                       new (W2). Node loader: dir -> LoadedTable, vault root -> LoadedTable[] (CLI;
                                         absorbs cli/check.ts readInput + scripts/check-references.ts loaders).
src/lib/load/tauri.ts                    the reactive watcher home (W3); table.svelte.ts + vault.svelte.ts live here logically.

src/routes/(vaults)/vault/[id]/
  VaultView.svelte -> the Vault shell (table switcher + active grid + integrity panel).
  The current single-grid VaultView becomes the active-Table pane inside it.

src/routes/demo/  and  src/routes/demo/references/
  Deleted in Wave 4. demo-vault, references-demo, references-fixtures, ReferenceDatabase all go.
```

### The Rust change (the real cost, named honestly)

The watcher grows from "watch one folder" to "shallow-watch a root + compose per-folder watches."

- Keep `watch_folder` / `unwatch_folder` as the **Table** primitive. It is correct and stays.
- Add a depth-1 watch on the vault root that emits a delta when a child folder appears, disappears, or gains/loses a `matter.json`. This is the **vault membership** signal; the JS Vault reacts by composing or disposing a Table watch.
- `FileDelta` is unchanged for Tables. The root signal is a separate, smaller payload (a folder name plus present/absent); regenerate the ts-rs binding with `cargo test`.
- `write_mirror` / `query_mirror` move from a folder path to the vault root path with a table-name argument (one db, many tables). `read_entry` / `write_entry` are unchanged (still per-file).

This is the chunk that was correctly out of scope for the small documentation fix. It is the point of the redesign, isolated to Wave 3 and Wave 5.

## Call Sites

```
createVault          src/lib/vault.svelte.ts (def), routes/(vaults)/vault/[id]/VaultView.svelte
FolderGridVault      vault.svelte.ts (def), components/FolderGrid.svelte, demo/demo-vault.svelte.ts
createDemoVault      routes/demo/+page.svelte
createReferencesDemo routes/demo/references/+page.svelte (deleted Wave 4)
LoadedFolder         check/references.ts (def), references-demo.svelte.ts, scripts/check-references.ts
checkReferences      check/references.test.ts, scripts/check-references.ts, references-demo (-> resolveReferences)
watch_folder         src-tauri/src/lib.rs (command registry), vault.svelte.ts (-> createTable)
```

Run `rg` for each before editing; the renames are mechanical but wide.

## Implementation Plan (waves)

Each wave is independently green (tests + typecheck) and commits as its own reviewable unit. The contained refactors come first, the Rust cost is in the middle, the payoff is last.

```
W1  Rename the watcher primitive in place. No behavior change.
    vault.svelte.ts -> table.svelte.ts; createVault -> createTable; Vault -> TableHandle;
    FolderGridVault -> TableView; createDemoVault -> createDemoTable. Routes/tabs keep "vault"
    naming (a vault currently holds one table; forward-compatible). No bare Table type, so no
    UI-Table collision. All 95 tests stay green.

W2  Unify the report vocabulary AND the pipeline. No primitive change (conformance untouched).
    FULL unification, staged as ~6 reviewable commits. Touches CLI + core + report + load only,
    never the live grid (check/ is imported solely by cli/check.ts and its own tests), and defers
    the model->contract / folder->table renames to Wave 3. Commits:
      1. Move check/references.ts -> core/references.ts; checkReferences -> resolveReferences;
         LoadedFolder {table,read} -> LoadedTable {name,read}. Same logic; update test + the 3
         consumers. Pure move/rename, green.
      2. Add core/integrity.ts: AssessedCell (7-way), TableAssessment (4 states), RowAssessment,
         VaultIntegrity, and assess(tables) composing conformance (Cell -> AssessedCell widening)
         + resolveReferences. + tests.
      3. Add report/ (was check/): violations.ts (toViolations, summarize, tierOf, Violation),
         expected.ts (ExpectedValue, describeExpected), format.ts (formatExpected + human text),
         exit-code.ts. Pure selectors over VaultIntegrity.
      4. Add load/fs.ts: dir -> LoadedTable, vault root -> LoadedTable[] (one home for the disk
         listing currently duplicated in cli/check.ts and scripts/check-references.ts).
      5. Rewire cli/check.ts onto load/fs -> assess -> report; scope inferred from the path;
         fold scripts/check-references.ts in (delete it). DELETE check/check.ts, check/report.ts
         (CheckReport/FatalCheckReport). unmodeled exits 0 + note.
      6. Demo: mechanical import fix only (resolveReferences/LoadedTable from core/references).
         No vocabulary rewrite; Wave 4 deletes the demo.
    De-risks the report shape and the loader before live wiring, with one report vocabulary at the
    wave boundary.

W3  Lift the primitive. createVault(rootPath) composes createTable per child + a depth-1 Rust
    root-discovery watch (folder added/removed, matter.json gained/lost). core/folder.ts -> core/table.ts;
    core/vault.ts (LoadedVault). open-vaults holds roots; one tab = one vault with a table switcher.
    content-vault opens correctly. The real cost (Rust + ts-rs regen). "model" -> "contract" copy lands here.

W4  Live integrity. integrity(vault) as a $derived; the integrity panel + grid reference chips render
    over real reads. Delete /demo, /demo/references, demo-vault, references-demo, references-fixtures,
    ReferenceDatabase. The example vault IS the demo now.

W5  Per-vault SQLite. One db per vault root, one SQL table per folder; WHERE scoped to the active table;
    cross-table JOIN queries enabled.
```

Tabs stay per-folder through W1 and W2 and flip to per-vault at W3, so working behavior is never lost mid-stream. W1 is safe to start immediately while the rest of the design settles.

## Edge Cases

```
Empty vault root            no table-folders yet: the shell shows an empty state, not an error.
Loose .md at the root       the root's own markdown is an untyped Table named for the root (optional;
                            could also be ignored). Decide in Wave 3.
Folder with no matter.json  an untyped Table (raw grid), still a valid reference target.
A table-folder removed      the Vault disposes its watch; inbound references to it become missing-target.
Nested vaults               a table-folder that itself contains table-folders: depth-1 discovery only;
                            do not recurse arbitrarily (refuse the tree-walker).
matter.json appears later   the root discovery watch upgrades an untyped Table to modeled, live.
Table fails to load         status 'fatal' in the report; no violations of its own; inbound references
                            to it become missing-target.
```

## Open Forks (owner's taste, not the code's)

1. **Naming: `Vault` (root) + `Table` (folder).** Recommended. It moves "vault" up to where `content-vault` already pointed, and "Table" is honest. Resolved in code by naming the runtime handle `TableHandle` and the grid boundary `TableView`, so no bare `Table` data type collides with the `@epicenter/ui` `Table` component namespace.

2. **`Vault` collides with the Epicenter secret-vault.** The encrypted-KV "vault" work uses the same word for a Yjs workspace. They rarely co-occur in code, and "Vault" fits Matter's Obsidian-flavored markdown identity and the `content-vault` example name. Recommended: keep Vault for Matter, disambiguate only if they ever share a package. The collision-free relational alternative is Airtable's "Base" (a Base contains Tables) if maximal precision is preferred over familiarity. Decide before Wave 3 (it sets the route and open-vaults vocabulary).

3. **One tab = one Vault (with an in-vault Table switcher), or tabs stay per-Table.** Recommended: one tab per Vault, Notion-style shell. Affects Wave 3's route shape.

4. **Per-vault SQLite now (Wave 5) or keep per-folder and add joins later.** Recommended: do it with the rename, because cross-table joins are the whole reason the primitive matters, and retrofitting later touches the same files twice.

## Success Criteria

```
- Opening examples/matter/content-vault shows three Tables (pages, adaptations, publications),
  not "no model for this folder."
- Reference chips render in the live grid, colored resolved / dangling / missing-target by the
  same verdict the integrity report produces.
- Removing a table-folder flips its inbound references to missing-target live.
- The Integrity panel matches `scripts/check-references.ts` over the same vault, in one vocabulary.
- conformance and resolveReferences stay pure with their existing tests; integrity composes them;
  the grid keeps its full per-cell state model.
- A cross-table SQL JOIN over two folders returns rows (Wave 5).
- /demo/references and its fixtures are deleted; the example vault is the demo.
- All matter tests + svelte-check green at each wave boundary.
```

## Relationship to the shipped small fix

Commit `9e372cd75` (onboarding copy + the `content-vault` README note) is a signpost in front of this hole: it tells users to open a child folder and points at the demo. This spec fills the hole. When Wave 3 lands, the README's "opening it in the live app" caveat and the onboarding "open one leaf folder, not a parent" guidance are both **deleted**, because opening the parent vault becomes the correct, primary action.
