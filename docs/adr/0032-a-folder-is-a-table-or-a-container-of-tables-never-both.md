# 0032. A folder is a table or a container of tables, never both

- **Status:** Accepted
- **Date:** 2026-06-19
- **Supersedes:** [ADR-0031](0031-subtables-are-navigated-by-re-rooting-the-scope.md)

## Context

[ADR-0029](0029-matter-json-marks-a-table.md) made a `matter.json` the table
marker and, in the same record, made nesting first-class: a marked folder could
be both a table (its own rows) and a container of marked child tables shown
beside it. [ADR-0030](0030-references-resolve-within-a-folder-and-its-immediate-children.md)
then had to bound reference resolution to one level, and
[ADR-0031](0031-subtables-are-navigated-by-re-rooting-the-scope.md) had to invent
a descend-by-re-rooting UI to reach deeper tables.

But matter's reason to exist is **cross-table references** (`adaptations.page ->
pages`), and references need a **flat, co-resident, closed universe**: every
participating table loaded in one scope. Nesting works against that. ADR-0030
deliberately stops references at one level, so each level of nesting **fragments**
the reference graph into islands that cannot see each other. The feature that
makes matter worth using wants everything flat; subtables push the other way. No
real or example vault nests (every one is an unmarked root of marked leaf
tables), and the cases that motivated nesting all resolve better flat: sibling
tables with a foreign key (`chapters.character -> characters`), co-located
independent datasets (open each as its own vault), or asset bundles (already
handled by the marker rule ignoring unmarked subfolders).

## Decision

A folder is a table **or** a container of tables, never both:

- a **marked** folder IS a single table; its `.md` files are rows and its
  subfolders are ignored (even when themselves marked);
- an **unmarked** folder is a container; its immediate marked child folders are
  the tables, and *their* subfolders are ignored.

Depth is reached by **re-opening the deeper folder**, never by loading two levels
into one scope. The loader and watcher return exactly one of these two sets:
`isMarked(path) ? [path] : [path's marked children]` (`loadPath` in
`apps/matter/src/lib/load/fs.ts`, `scan_vault` in
`apps/matter/src-tauri/src/watch.rs`).

The vault view renders that scope as a **flat tab bar** of peer tables. There is
no subtable, no descend affordance, and no scope coordinate in the URL; opening a
different folder is the only way to change which closed universe is loaded.

## Consequences

Dissolved:

- the "a folder is both a table and a container" case, and with it the whole
  descend / re-rooting plan ADR-0031 deferred (its three open questions evaporate);
- the only way a loaded scope could span more than one level, so every view is a
  clean flat reference universe by construction.

Simpler:

- [ADR-0030](0030-references-resolve-within-a-folder-and-its-immediate-children.md)
  stands unchanged in mechanism (one scope, bare names, no durable format change,
  reduces to `tables.length === 1`), but the "own rows PLUS immediate marked
  children" case it anticipated can no longer co-occur: the scope is either one
  lone marked table or a container's marked children.

Cost (the one sharp edge):

- marking a **container** folder silently hides its child tables: matter then
  shows that folder as a single table, and the children must be opened
  individually. This is rare (you do not usually mark a container) and arguably
  correct ("you told me this folder is a table, so I show it as one"), but it is a
  real discontinuity at the marker.

## Considered alternatives

- **Keep nesting first-class (ADR-0029 as written).** Rejected: it fragments the
  reference graph that is matter's entire point, needs the deferred descend UI to
  be usable, and no vault actually nests. The shipped loader was already ~95% the
  flat model; nesting only added the both-at-once case and the unbuilt descent.
- **Grouped or indented tabs / a flat list across all levels.** Already rejected
  by ADR-0031 for misrepresenting the peer relationship or dissolving the closed
  universe; moot once subtables are gone.
