# epicenter apply: declarative markdown reconcile into Yjs

Status: Phase 1 built (frontmatter reconcile); Phase 2 (bodies) and Phase 3 (CLI) pending
Date: 2026-06-01
Mounts touched: `apps/fuji`, `packages/workspace` (markdown materializer), `packages/cli`

## v1 status (built)

Shipped in `packages/workspace` markdown materializer:
- `markdown_apply({ dryRun?, maxDeletes? }) -> ApplyPlan`: id-keyed declarative
  reconcile (create/update/delete) with all-or-nothing guards.
- Equality via `Value.Equal` (not a stringify hack).
- Delete safety: a MISSING directory contributes no deletes (a `present` flag
  distinguishes it from an empty one); a delete count over `maxDeletes` refuses;
  `maxDeletes: 0` is the escape hatch.
- Refuses on duplicate frontmatter id (`MaterializerApplyError.DuplicateId`) and
  on any table that customizes `toMarkdown` without a `fromMarkdown`
  (`RoundTripUnproven`), since that path would silently drop data.
- Tests: 8 unit (`apply.test.ts`) + 1 two-peer convergence e2e
  (`reconcile-e2e.test.ts`).

NOT yet built: fuji body import (fuji has `toMarkdown` but no `fromMarkdown`, so
apply currently REFUSES the fuji entries table by design), the `epicenter apply`
CLI, and the real two-vault runbook. See Phases 2 and 3 below.

## Problem

The daemon materializes Yjs to markdown (one-way: `Yjs -> disk`). Editing the
markdown does nothing: it is output. We want a coding agent (or a human in an
editor) to edit the markdown directly and have those edits flow back into Yjs,
which then propagates to every device through the existing relay.

Today the write path is `action -> daemon socket -> Y.Doc -> materialize`. We are
adding the inverse, gated and explicit: `disk -> Y.Doc`, called `apply`.

This is the user's "push them all up" idea, made non-destructive. It is a
declarative reconcile (desired-state apply), not a git diff: compare the full set
of files on disk against the full set of rows in Yjs, key by frontmatter `id`,
and apply the delta. Git stays history/backup/publish only; it is not the
reconcile engine.

## Model

Two layers per entry, because fuji splits metadata from body:

```
fuji/entries/<slug>-<id>.md
├── frontmatter (id, title, tags, pinned, date, ...)   -> root `entries` table row
└── body (markdown below the second ---)               -> content doc entryContentDocGuid(id)
```

`apply` reconciles both layers. The root table row is a set-diff by `id`. The
body is written into the per-entry content doc.

Materialize and apply are inverses and must round-trip:

```
materialize:  row + body            ->  <slug>-<id>.md
apply:        <slug>-<id>.md        ->  row + body
invariant:    materialize(apply(files)) == files     (deterministic, byte-stable)
```

## What already exists (do not rebuild)

```
packages/workspace/.../markdown/materializer.ts
  markdown_push     disk -> workspace, ADDITIVE. Reads .md, parses frontmatter,
                    runs per-table fromMarkdown (default: frontmatter as row),
                    validates against schema, table.set(row). No deletes, no
                    dry-run, no body handling.
  markdown_pull     workspace -> disk, additive.
  markdown_rebuild  workspace -> disk, destructive sweep + rewrite.
  createGitAutosave quietMs debounce + maxBatchMs cap, enqueue(path) on write.

apps/fuji/src/lib/workspace/project.ts
  readEntryBody(entry)   opens entryContentDocGuid(id), syncs, attachRichText().read(), destroys.
  (NO writeEntryBody yet.)

apps/fuji/src/lib/workspace/index.ts
  entries_upsert   full-row insert/replace.
  entries_delete   soft delete (sets deletedAt).
  entryContentDocGuid(id), asEntryId, Entry type.
```

`markdown_push` already does creates + updates of the frontmatter row safely
(schema-validated, id-keyed). The gaps are: deletes, dry-run, a delete guard, and
bodies.

## Design

### Phase 1: generic `markdown_apply` (frontmatter rows only)

Add one action to `attachMarkdownMaterializer`. It is the existing push read path
plus a set-diff and a guarded delete. No body knowledge; fully generic and
testable without content docs or the cloud.

```ts
markdown_apply({ dryRun?: boolean, maxDeletes?: number }) -> ApplyPlan

type ApplyPlan = {
  refused: boolean;          // true when a guard tripped; nothing was applied
  reason?: string;
  creates: { tableName: string; id: string }[];
  updates: { tableName: string; id: string }[];
  deletes: { tableName: string; id: string }[];
  skipped: { path: string; reason: string }[];   // missing id, parse fail, validation fail
  errors:  { path: string; error: unknown }[];
};
```

Algorithm per registered table:

```
1. desired = read every .md in <dir>, parse frontmatter (reuse push's parse +
   schema validation). Key by frontmatter.id. A file with no id, a parse failure,
   or a validation failure goes to skipped/errors and is NEVER partially applied.

2. current = table.getAllValid()  keyed by id.

3. diff:
   creates = desired - current
   updates = (desired ∩ current) where row fields differ
   deletes = current - desired

4. guard (before any write):
   if deletes.length > (maxDeletes ?? DEFAULT_MAX_DELETES) -> refused: true, return plan.
   if errors.length > 0                                    -> refused: true, return plan.
   (A broken file must never cause its row to be read as a delete.)

5. if dryRun -> return plan, write nothing.

6. apply:
   creates + updates -> table.set(row)        (schema-validated row from step 1)
   deletes           -> onDelete(id)          (configurable; fuji passes soft-delete)
   return plan.
```

`onDelete` is a per-materializer config hook. Default is hard `table.delete(id)`.
The fuji mount passes soft-delete (route through the same path as `entries_delete`
so deleted rows keep tombstones and sync correctly). This satisfies "never
silently delete": deletes are soft, counted, guarded, and shown in dry-run.

`DEFAULT_MAX_DELETES`: start strict (e.g. 5, or 25% of current rows, whichever is
larger). Tune after real use. Override with `--allow-deletes N` or `--force`.

### Phase 2: fuji body import

Add the symmetric inverse of `readEntryBody` to the fuji mount:

```ts
const writeEntryBody = async (entry: Entry, body: string): Promise<void> => {
  const ydoc = new Y.Doc({ guid: entryContentDocGuid(entry.id), gc: true });
  const collaboration = openCollaboration(ydoc, { /* same args as readEntryBody */ });
  try {
    await collaboration.whenConnected;
    attachRichText(ydoc).applyText(body);   // see "body write" below
  } finally {
    ydoc.destroy();
    await collaboration.whenDisposed;
  }
};
```

Wire it into the fuji `perTable.entries` config as the body half of apply. Two
clean options; pick one in implementation:

- (a) Give `markdown_apply` an optional `onBody(id, body)` per-table hook called
  for each create/update during the apply phase (not dry-run). fuji passes
  `writeEntryBody`. Keeps body out of the generic differ.
- (b) Keep apply row-only and have the CLI call body writes after the row plan
  applies. Simpler materializer, more orchestration in the CLI.

Prefer (a): one action, one transaction boundary, body writes gated by the same
dry-run/guard.

Body write requirement (IMPORTANT): `applyText(body)` must apply a minimal text
diff into the existing `Y.Text`, not delete-all-then-insert. Wholesale replace
destroys concurrent-edit merge and makes every apply churn the content doc even
when the body is unchanged. If `attachRichText` has no diff-apply method, add one
(compute a common prefix/suffix and splice the middle). This also makes "did the
body change?" detectable: a diff-apply that produces zero ops means no change.

### Phase 3: CLI command

```
packages/cli: `epicenter apply`
  --mount <name>        required; e.g. fuji
  --dry-run             print the plan, change nothing
  --allow-deletes <n>   raise the delete guard
  --force               apply regardless of guard (still soft deletes)
```

Implementation: `connectDaemonActions<FujiActions & MaterializerActions>({ mount })`
then call `markdown_apply({ dryRun, maxDeletes })`. Print the plan as a table.
The daemon owns the Y.Doc and content-doc sync; the CLI never opens its own doc
(matches the vault AGENTS.md contract).

Reconcile trigger is explicit (`epicenter apply`) for v1. No filesystem watcher.
A later option: run apply on `git commit` via a hook, since the commit is a clean
"the agent is done" boundary. Out of scope here.

## Multi-vault: why it works end to end

A fuji mount derives its workspace doc guid from `FUJI_ID = 'epicenter-fuji'`, and
syncs through the relay keyed by `ownerId + guid`. Two vaults on two machines (or
two directories), both authed as the same user, both mounting fuji, resolve to the
SAME relay room. They are already multi-device peers.

```
vault-A/fuji/entries/x.md  --(edit)-->  epicenter apply --mount fuji
        |                                        |
        |                                writes row + body into Y.Doc (A's daemon)
        |                                        |
        |                                  relay (ownerId + guid)
        |                                        |
        |                              A's update reaches B's daemon
        |                                        |
        |                                 B materializes x.md
        v                                        v
   diff vault-A/fuji/entries/x.md  ==  vault-B/fuji/entries/x.md   (must be empty)
```

The empty `diff` is the whole proof: it confirms (1) apply imported the edit, (2)
the relay propagated it, (3) deterministic materialization reproduced byte-identical
output on a different machine. No git involved in the loop.

## Invariants (mapped to hard requirements)

1. No silent delete: deletes are soft (`deletedAt`), counted, guarded by
   `maxDeletes`, and shown in `--dry-run` before any write.
2. Git never mutates the live dir: apply reads files and writes Yjs; it does not
   run git. Git autosave is a separate, already-existing materialize-side concern.
3. Import is explicit: `epicenter apply` is a command, never a watcher.
4. Deterministic materialize: `materialize(apply(files)) == files`. Frontmatter
   key order = schema order; filename = `slugFilename('title')` -> `<slug>-<id>.md`;
   id is the stable suffix so a rename is an update, not delete+create.
5. Yjs is truth: apply writes rows + body into Yjs; the relay does propagation.
6. Prefer Yjs over raw git conflict: there are no git merges in this path at all.
7. Offline: apply works against the local daemon; the relay flushes on reconnect.
8. Human-safe branch: unchanged by this spec; main is the converged projection.

## Tests

### T1 (unit, fast, no cloud): reconcile + delete guard

`packages/workspace/.../markdown/apply.test.ts`, same style as `materializer.test.ts`.

```
- seed table with rows A, B, C; materialize to a temp dir.
- edit B's frontmatter on disk, delete C's file, add a new file D (valid frontmatter).
- markdown_apply({ dryRun: true })  -> plan = { creates:[D], updates:[B], deletes:[C] },
    table unchanged.
- markdown_apply()                  -> table now has A, B(updated), D; C soft-deleted.
- materialize again -> the on-disk tree matches { A, B', D } exactly (round-trip).
```

Guard test:

```
- delete 9 of 10 files; markdown_apply({ maxDeletes: 5 }) -> refused: true, table UNCHANGED.
- markdown_apply({ maxDeletes: 5, force via allow-deletes }) -> applies, all soft-deleted.
```

Bad-file test:

```
- corrupt one file (no frontmatter); markdown_apply() -> that file in skipped/errors,
    refused: true if errors>0, NO row deleted because of the unreadable file.
```

### T2 (in-process e2e, no cloud): two peers converge

Prove apply -> propagate -> deterministic materialize without the relay, by wiring
two Y.Docs directly (the standard Yjs peer-sim):

```
- docA, docB = two createFuji() instances; wire updates both ways
    (docA.on('update', u => Y.applyUpdate(docB, u)) and the reverse).
- attach a markdown materializer to docA -> dirA, docB -> dirB.
- write/edit .md files in dirA; run markdown_apply on docA.
- assert dirA tree == dirB tree (byte-identical), proving import + propagation + determinism.
(Phase 1 only: frontmatter rows. Bodies need content-doc pairs; defer to T3 manual.)
```

### T3 (manual runbook, real cloud): two vaults

The full thing the user wants to see, including bodies. See "Execution" below.

## Execution (how to see it work)

Phase 1 unit + in-process e2e (no auth, no cloud):

```bash
cd ~/Code/epicenter
bun test packages/workspace/src/document/materializer/markdown/apply.test.ts
```

Single vault, live (needs `auth login` + daemon):

```bash
cd ~/Code/vault
bun run daemon                      # terminal 1, foreground
# terminal 2:
$EP apply --mount fuji --dry-run    # print the plan, change nothing
# edit a real file, e.g. change a title or body in fuji/entries/<file>.md
$EP apply --mount fuji --dry-run    # plan now shows that one update
$EP apply --mount fuji              # apply it
bun run list-entries                # confirm the row changed
# where: EP="bun ../epicenter/packages/cli/src/bin.ts"
```

Two vaults, end to end (the cross-repo proof):

```bash
# vault-B: same config + same auth, fresh local state, different directory
cp -R ~/Code/vault ~/Code/vault-b && cd ~/Code/vault-b && rm -rf .epicenter
bun run daemon                      # terminal B: builds local state from cloud

cd ~/Code/vault && bun run daemon   # terminal A
# terminal A2: edit fuji/entries/x.md, then:
$EP apply --mount fuji
# wait for sync, then compare the two repos' rendering of the same entry:
diff ~/Code/vault/fuji/entries/x.md ~/Code/vault-b/fuji/entries/x.md   # expect: no output
```

Empty `diff` = the edit made it from vault-A's markdown, through Yjs and the relay,
into vault-B's markdown, byte-for-byte. That is the design working end to end.

## Open questions / risks

- Body change detection cost: deciding "did the body change?" requires reading the
  current content doc (a sync round-trip per entry). v1 may just diff-apply every
  changed-frontmatter entry's body and rely on diff-apply producing zero ops when
  unchanged. v2: store a body content-hash in frontmatter to skip untouched bodies.
- `attachRichText` may not expose a diff-apply; if not, that is a prerequisite
  sub-task (Phase 2 cannot ship a safe body import without it).
- Concurrent apply from two vaults at once reintroduces the multi-writer question.
  For now: apply from one place at a time. Yjs still merges correctly; this is about
  not surprising the user, not about corruption.
- `markdown_push` currently ignores bodies entirely; Phase 2's `onBody` hook (or the
  fuji `fromMarkdown`) is what closes that gap. Confirm which seam before coding.
```
