# 0031. The vault view is one scope; subtables are navigated by re-rooting

- **Status:** Accepted
- **Date:** 2026-06-19

## Context

[ADR-0029](0029-matter-json-marks-a-table.md) made nesting first-class (a marked
folder inside a marked folder), and [ADR-0030](0030-references-resolve-within-a-folder-and-its-immediate-children.md)
made references resolve within exactly one scope: the opened folder's rows plus
its immediate marked child tables. The loader and watcher return that scope
(`loadPath(F)` / `scan_vault(F)` = `[F if marked, ...F's immediate marked
children]`); they deliberately do not load grandchildren. The UI question that
forced this ADR: how does a user see and navigate that nesting, and what happens
when a subtable has its own subtables?

## Decision

The vault view is **exactly one scope**: a folder plus its immediate marked
children, rendered as a flat tab bar where the folder's own rows (when it is
marked) and each subtable are **peers**. They are peers because ADR-0030 resolves
their references as one flat closed universe; ranking them visually would
misrepresent that.

To go deeper, a user **re-roots the scope** at a subtable: opening child `G`
makes `[G, ...G's marked children]` the new scope. Depth is reached by descent,
never by flattening every table across levels into one list. A re-rooted scope is
a new keyed vault with its own reference resolution and its own SQLite mirror,
which is correct: dropping the parent scope's references on descent is exactly
the closed-universe boundary ADR-0030 defines (cross-level references are
intentionally unevaluable), not a regression.

## Consequences

- Descent is purely **additive** and is **deferred** until nesting is actually
  used. No real or example vault nests today (every one is a single level:
  an unmarked root of marked leaf tables), so flat tabs render every existing
  vault correctly, and shipping descent now would build chrome for an unused
  capability. Nothing in the shipped V1 forecloses it.
- When built, descent needs: a `hasMarkedChildren` bit on the scan output (so a
  tab shows a descend affordance only when it leads somewhere, with no extra stat
  round-trip), a scope coordinate in the URL that re-roots the keyed vault
  (e.g. `?scope=<path-relative-to-the-open-tab>`, kept within the tab rather than
  opening a new persisted tab), and a breadcrumb for the path back up. Selecting a
  tab (an in-scope render choice) stays distinct from descending into it
  (changing which closed universe is loaded).
- The per-scope SQLite mirror and integrity assessment already hold at every
  level by construction; a re-rooted child gets its own projection.

Open questions to resolve when descent is implemented (not load-bearing now):

- Per-scope `.matter/matter.sqlite` proliferation when drilling deep: accept the
  on-disk projection per visited scope, or root the mirror only at opened tabs and
  re-scope via SQL views?
- A scope coordinate within the tab (`?scope=`) versus a new persisted tab per
  drill (leaning: within the tab; descent is navigation, not a new open vault).
- When a marked root has child tables (the new ADR-0029 case with no example
  yet): is the root's own rows a peer tab, or the breadcrumb's current node?

## Considered alternatives

- **Grouped or indented tabs** (subtables ranked under their parent in one bar).
  Rejected: it implies a hierarchy the scope does not have (the tables are
  reference peers), and it still cannot descend into a subtable's own children, so
  it is decoration that misrepresents the model and solves nothing.
- **A flat list of every table across all levels.** Rejected: it dissolves the
  one-scope closed universe, which forces cross-level reference resolution that
  ADR-0030 deliberately excludes (and would need path-qualified names).
- **A persistent left-hand tree.** Deferred, not rejected: the right rendering
  once vaults are routinely several levels deep, but over-built for the
  single-level vaults that exist. It is a later rendering of the same scope stack,
  not a different model.

## V1 shipped

A flat tab bar over the current scope (subtables already appear as the loader and
watcher list them), plus an "adopt folder as a table" action in the empty state
that writes the `{}` marker so an unmarked folder can become a table.
