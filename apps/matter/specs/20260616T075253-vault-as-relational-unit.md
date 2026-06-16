# Vault as the Relational Unit (`apps/matter`)

**Date**: 2026-06-16
**Status**: Proposed (greenfield direction; compatibility pressure explicitly released by the owner)
**Owner**: Braden
**Branch**: feat/field-reference-kind
**Depends on**: the reference field kind (`packages/field`), `checkReferences` (`src/lib/check/references.ts`), the per-folder watcher (`src-tauri/src/watch.rs`), and the SQLite mirror (`src/lib/core/sqlite.ts` + `src-tauri/src/mirror.rs`), all already shipped or in flight on this branch.

## One Sentence

Promote the **Vault** (a directory of typed markdown tables) to Matter's primary object so references resolve live across a real on-disk vault instead of in a fixtures-only demo, renaming today's single-folder "vault" to **Table** and moving the watched and queried unit up one level from the folder to its parent.

## How to read this spec

```
Read first:        One Sentence · The Core Insight · Product Sentence · Target Shape
Read for design:   Naming Map · Ownership Pass · Refusals · Architecture
Read to execute:   Call Sites · Implementation Plan · Edge Cases · Success Criteria
Read for taste:    Open Forks (the three decisions that are the owner's, not the code's)
```

The single load-bearing decision is the **primitive promotion** (folder to vault). Every rename, file move, and the SQLite relocation are downstream of it.

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

The naming overload is a symptom. The fix is not to rename "vault"; it is to move the primitive up a level so the word lands where it belongs.

## The Core Insight

Matter is a tool that treats a **directory tree of markdown as a typed, relational, queryable database**, where the filesystem is the source of truth and the schema travels with the data (per-folder `matter.json`). It already has every capability: typed columns (conformance), SQL queries (the mirror), and relations (references). It just chose the folder, not the folder's parent, as the unit the user opens, watches, and queries. Lifting that one choice makes references first-class, makes `content-vault` correct, and collapses the demo into reality.

## Product Sentence

> A **Vault** owns a directory of typed markdown **Tables**. The app enters through one Vault and resolves **references** across its Tables. Each Table's `matter.json` owns its own **contract**; the filesystem owns every **Row**.

Everything below is judged against this sentence. If a path, branch, type, or helper survives the sentence being true, it is removable.

## Target Shape

### The object model

```
Vault    a directory the user opens. Owns the set of Tables discovered beneath it,
         one SQLite mirror, and the live reference resolution across its Tables.
         (was: the parent of `content-vault`, a concept the app had no name for)

Table    one folder of markdown. Owns its rows and its optional matter.json contract.
         A modeled Table has a typed schema; an unmodeled Table is a raw frontmatter grid.
         (was: "vault" / createVault / FolderGridVault)

Row      one .md file. fileName + stem + frontmatter + body. Identity is the stem;
         no id is minted. (unchanged)

Contract the matter.json in a Table folder: that Table's column schema, self-describing
         and portable. (was: "model"; standardize the word to "contract", which the UI copy
         already uses)

Reference a field whose value is a target Row's stem in another Table of the same Vault.
         Resolution is a Vault-level operation. Dangling is a surfaced state, never repaired.
         (unchanged storage: a plain stem string)
```

### The runtime composition

`createVault(rootPath)` composes, it does not reimplement:

- A shallow watch on `rootPath` to detect Table folders appearing and disappearing (a folder gains/loses a `matter.json`, a folder is added/removed).
- For each child folder, a `createTable(folderPath)` instance: today's `createVault` body, renamed, essentially unchanged. It already is a clean single-folder primitive (one store, one `applyDeltas` path, `whenReady`, `dispose`).
- The Vault owns disposal of its Tables: dispose the Vault, dispose every Table watch and the root watch.

The Vault is the **live union of its Tables' self-declared contracts**. It declares nothing itself. Discovery, not declaration.

### Reference resolution becomes live

`checkReferences` (today: a pure function called by a CLI script and the demo) becomes `vault.references`, a `$derived` over the loaded Tables' classified reads. The two finding kinds fall out of the Vault membership for free:

- `MISSING_TARGET`: the field's target Table is not present in this Vault.
- `UNRESOLVED`: the target Table is present, but no Row has that stem.

The pure function stays pure and keeps its tests; the Vault is the new caller that feeds it live reads instead of fixtures.

### The demo collapses into reality

`/demo/references` stops being a second implementation. "Demo" becomes **"open the bundled `examples/matter/content-vault` as a Vault."** The Notion-like relation view (table switcher, reference chips colored by verdict, the findings panel) becomes the **real Vault view**, driven by the real `readFolder` + resolution pipeline. Delete `references-fixtures.ts` and the inlined `createReferencesDemo`. One view, one code path, both the example and a user's own vault flow through it.

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
                  Table's grid (today's FolderGrid), and a live References panel.
                  (the demo's three-table layout, but over the real vault)
(removed)         /demo/references as a separate fixtures view. The bundled example
                  vault is reachable as a normal Vault; keep one onboarding entry that
                  opens it through the real pipeline.
```

The single-Table case is a degenerate Vault (one Table). The "no model" state stops being a dead-end banner and becomes an **untyped Table** in the vault, still listed, still a valid reference target (stems exist regardless of contract).

## Naming Map (old to new)

```
createVault(path)        -> createTable(path)            single-folder watcher (the body barely changes)
Vault (the type)         -> Table                        ReturnType of createTable
FolderGridVault          -> TableView                    the Pick<> boundary the grid renders from
createDemoVault          -> (deleted)                    demo opens the example vault instead
createReferencesDemo     -> (deleted)                    folded into the real Vault view
OpenVault {id,path,name} -> OpenVault {id,root,name}     a tab is a vault root, not a folder
open-vaults.svelte.ts    -> (kept, semantics lifted)     list of open VAULT ROOTS
/vault/[id]              -> /vault/[id]                   now resolves to a Vault root, renders the shell
"model" (matter.json)    -> "contract"                   one word, the UI copy already says "contract"
matter.sqlite (per dir)  -> matter.sqlite (per vault root) one db, one table per folder
checkReferences()        -> (kept pure) + vault.references live derived caller
(new)                    -> createVault(rootPath)        composes tables + root discovery watch
(new)                    -> watch_root / table discovery  Rust shallow root watch (see Architecture)
```

## Ownership Pass

```
selected vault       URL (/vault/[id]) + open-vaults list      which root is open
selected table       URL query or vault UI state               which table is active in the shell
table rows           the filesystem (the .md files)            durable product facts
table contract       that folder's matter.json                 self-describing, portable schema
reference resolution the Vault (derived over loaded tables)     the only place stems become links
vault membership     the Vault's root discovery watch           which folders are tables right now
sqlite mirror        the Vault (one db, full rebuild)           the external relational read surface
table watch lifetime the Vault (composes + disposes tables)     no table outlives its vault
```

No value has two owners. If two layers can create, repair, or cache the same value, the design is wrong and the duplicate path is deleted.

## Refusals

Greenfield discipline is also about what we refuse to add.

```
Candidate:  A central vault-level schema file (one matter.config that declares all tables + relations).
Refusal:    Per-folder matter.json is the right unit. A folder + its contract is self-contained and
            portable: hand someone `pages/` and the schema travels with it. The Vault discovers and
            composes; it declares nothing.
User loss:  No single-file view of the whole schema; the relation graph is implicit in x-ref markers.
Decision:   Refuse. Discovery over declaration.
Trigger:    Revisit only if a vault needs a relation that no source table can declare on its own field
            (e.g. many-to-many join tables with their own attributes).
```

```
Candidate:  Mint a stable Row id and reference by id instead of by stem.
Refusal:    Stem-string references are the wikilink primitive: human-authored, readable, the form an
            author already writes in frontmatter. The fragility (rename target -> dangle) is exactly
            what the validator surfaces. Minting ids fights the "no id is minted, the file is identity"
            ethos and makes files less hand-authorable.
User loss:  Renaming a target file dangles its inbound references (caught, not silent).
Decision:   Refuse. References stay plain stems. (This was an owner constraint; it is also the right
            greenfield call.)
Trigger:    Revisit only if a non-human writer becomes the primary author of these files.
```

```
Candidate:  A reference resolver / auto-fixer that repairs dangling references on read.
Refusal:    Dangling is a surfaced state, never a thing to silently repair. Repair code in a read path
            is a known smell; the References panel reports, it does not mutate.
User loss:  None; reporting is the product behavior.
Decision:   Refuse.
Trigger:    None foreseen.
```

```
Candidate:  Keep /demo/references (fixtures) alongside the real Vault view.
Refusal:    Two ways to do one thing. The fixtures exist only because the live pipeline could not load
            a vault; once it can, the example vault IS the demo.
User loss:  The demo no longer runs with `bun run dev` and zero filesystem; it needs the bundled example
            on disk (which is committed in the repo).
Decision:   Refuse the duplication. Collapse to the real view over the example vault.
Trigger:    None; if a pure-memory harness is ever needed for tests, the pure `readFolder` +
            `checkReferences` functions already serve that without a route.
```

## Architecture

### File moves (TypeScript)

```
src/lib/vault.svelte.ts
  createVault -> createTable; Vault -> Table; FolderGridVault -> TableView.
  Body is largely unchanged: it is already a clean single-folder watcher.
  Drop the per-folder mirror call; the Vault orchestrates the mirror now.

src/lib/vault-root.svelte.ts            (new)
  createVault(rootPath): composes createTable per child folder + a root discovery watch;
  owns the per-vault SQLite mirror rebuild and the live `references` derived.

src/lib/open-vaults.svelte.ts
  OpenVault.path -> OpenVault.root; dialog title "Open vault" (a directory of tables).
  Otherwise unchanged: the persisted tab list, lifted one level.

src/lib/check/references.ts
  checkReferences stays pure. Add nothing; the Vault calls it with live reads.

src/lib/core/sqlite.ts
  projectToSqlite stays per-table; add a vault-level rebuild that maps each Table to a
  SQL table in one db. MIRROR_TABLE becomes one-per-folder naming.

src/routes/(vaults)/vault/[id]/
  VaultView.svelte -> the Vault shell (table switcher + active grid + references panel).
  The current single-grid VaultView becomes the active-Table pane inside it.

src/routes/demo/  and  src/routes/demo/references/
  Deleted. demo-vault.svelte.ts, references-demo.svelte.ts, references-fixtures.ts,
  ReferenceDatabase.svelte all go. The example vault is opened as a normal Vault.
```

### The Rust change (the real cost, named honestly)

The watcher grows from "watch one folder" to "shallow-watch a root + compose per-folder watches." Concretely:

- Keep `watch_folder` / `unwatch_folder` as the **Table** primitive. It is correct and stays.
- Add a shallow (depth-1) watch on the vault root that emits a delta when a child folder appears, disappears, or gains/loses a `matter.json`. This is the **vault membership** signal; the JS Vault reacts by composing or disposing a Table watch.
- The `FileDelta` enum is unchanged for Tables. The root signal is a separate, smaller payload (a folder name plus present/absent); regenerate the ts-rs binding with `cargo test`.
- `write_mirror` / `query_mirror` move from a folder path to the vault root path with a table name argument (one db, many tables). `read_entry` / `write_entry` are unchanged (still per-file, per-table-folder).

This is the chunk that was correctly out of scope for the small documentation fix. It is the point of the redesign.

## Call Sites

```
createVault          src/lib/vault.svelte.ts (def), routes/(vaults)/vault/[id]/VaultView.svelte
FolderGridVault      vault.svelte.ts (def), components/FolderGrid.svelte, demo/demo-vault.svelte.ts
createDemoVault      routes/demo/+page.svelte (deleted with the demo)
createReferencesDemo routes/demo/references/+page.svelte (deleted)
OpenVault/open-vaults routes/(vaults)/+page.svelte, +layout.svelte, vault/[id]/+page.ts
checkReferences      check/references.test.ts, scripts/check-references.ts, demo (-> vault.references)
watch_folder         src-tauri/src/lib.rs (command registry), vault.svelte.ts (-> createTable)
```

Run `rg` for each before editing; the rename is mechanical but wide.

## Implementation Plan (waves)

Each wave is independently green (tests + typecheck) and commits as its own reviewable unit.

```
Wave 1  Rename in place, no behavior change.
        createVault -> createTable, Vault -> Table, FolderGridVault -> TableView.
        Routes still open one Table per tab. Pure rename; all 95 tests stay green.

Wave 2  Introduce createVault(rootPath) composing one Table (degenerate vault).
        open-vaults holds roots; /vault/[id] resolves a root, renders a shell with a single
        Table. No multi-table yet. Behavior identical, primitive lifted.

Wave 3  Root discovery watch (Rust) + multi-Table composition.
        Open a directory of table-folders; the shell lists all Tables; switch between them.
        content-vault now opens correctly.

Wave 4  Live references across the Vault.
        vault.references derived; the References panel renders over real reads; reference
        chips in the grid colored by verdict. Delete the demo and its fixtures here.

Wave 5  Per-vault SQLite mirror + cross-table queries.
        One db per vault root, one table per folder; WHERE filter scoped to the active table;
        cross-table JOIN queries enabled.
```

Waves 1 and 2 are safe and mostly mechanical. Wave 3 is the Rust cost. Waves 4 and 5 are the payoff.

## Edge Cases

```
Empty vault root            no table-folders yet: the shell shows an empty state, not an error.
Loose .md at the root       the root's own markdown is an untyped Table named for the root (optional;
                            could also be ignored). Decide in Wave 3.
Folder with no matter.json  an untyped Table (raw grid), still a valid reference target.
A table-folder removed      the Vault disposes its watch; inbound references to it become MISSING_TARGET.
Nested vaults               a table-folder that itself contains table-folders: depth-1 discovery only;
                            do not recurse arbitrarily (refuse the tree-walker).
matter.json appears later   the root discovery watch upgrades an untyped Table to modeled, live.
```

## Open Forks (owner's taste, not the code's)

1. **Naming: `Vault` (root) + `Table` (folder).** Recommended. It moves "vault" up to where `content-vault` already pointed, and "Table" is honest. The alternative, coining "Workspace" for the root, collides with Epicenter's heavily-used Yjs "workspace"; Matter is filesystem-native, so the Obsidian-flavored "Vault" fits better. Decision needed before Wave 1 (it sets every rename).

2. **One tab = one Vault (with an in-vault Table switcher), or tabs stay per-Table.** Recommended: one tab per Vault, Notion-style shell. Affects Wave 2's route shape.

3. **Per-vault SQLite now (Wave 5) or keep per-folder and add joins later.** Recommended: do it with the rename, because cross-table joins are the whole reason the primitive matters, and retrofitting later touches the same files twice.

## Success Criteria

```
- Opening examples/matter/content-vault shows three Tables (pages, adaptations, publications),
  not "no model for this folder."
- Reference chips render in the live grid, colored resolved / dangling / missing-target by the
  same verdict checkReferences produces.
- Removing a table-folder flips its inbound references to MISSING_TARGET live.
- The References panel matches `scripts/check-references.ts` over the same vault.
- A cross-table SQL JOIN over two folders returns rows (Wave 5).
- /demo/references and its fixtures are deleted; the example vault is the demo.
- checkReferences and readFolder stay pure with their existing tests; the Vault is the new live caller.
- All matter tests + svelte-check green at each wave boundary.
```

## Relationship to the shipped small fix

Commit `9e372cd75` (onboarding copy + the `content-vault` README note) is a signpost in front of this hole: it tells users to open a child folder and points at the demo. This spec fills the hole. When Wave 3 lands, the README's "opening it in the live app" caveat and the onboarding "open one leaf folder, not a parent" guidance are both **deleted**, because opening the parent vault becomes the correct, primary action.
