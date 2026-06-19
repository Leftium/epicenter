# 0030. References resolve within a folder and its immediate child tables

- **Status:** Accepted (scope simplified by [ADR-0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md))
- **Date:** 2026-06-19

> The one-scope rule, bare names, no durable format change, and the
> `tables.length === 1` discriminant below all stand.
> [ADR-0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md) drops
> subtables, so the "a folder's own rows PLUS its immediate marked child tables"
> case never co-occurs: a scope is either one lone marked table or a container's
> marked children.

## Context

[ADR-0029](0029-matter-json-marks-a-table.md) makes a `matter.json` the table
marker and lets marked tables nest (a marked folder inside a marked folder).
matter's integrity model is cross-table reference resolution (`adaptations.page
-> pages`): a reference is a bare table name that must resolve inside a closed
universe. Nesting forces the question the flat model never had: across how many
levels does a bare name resolve, and must the reference syntax in users' `.md`
frontmatter (a durable format) change?

## Decision

A reference resolves within **one scope: the opened folder's own rows plus its
immediate marked child tables.** Not across cousins, not down the whole subtree.

- References stay **bare table names**. Bounded to one level, names stay
  unambiguous and **the on-disk `.md` format does not change.**
- A reference whose target is not in the loaded scope is *unevaluable* when the
  scope is a lone table (no marked children loaded) and a *dangling-reference*
  failure when child tables are loaded (the scope is then the complete, closed
  universe). This is the honest replacement for the old `scope: 'table' |
  'vault'` discriminant: it reduces to `tables.length === 1`.
- The UI and the CLI use the **same** scope.

## Consequences

- The closed-universe property holds at every level of nesting, not just a flat
  root.
- No durable content migration: a flat vault validates exactly as before (its
  root has no rows; its marked children are the scope).
- Forecloses references spanning more than one level. If ever needed, that is a
  **new ADR introducing path-qualified references** (`pages/intro`), a deliberate
  durable-format change.
  - **Trigger to revisit:** a real vault needs a row to reference a grandchild or
    cousin table and neither flattening nor a local subtable can express it.

## Considered alternatives

- **Whole-subtree resolution.** Rejected: forces path-qualified references now,
  or leaves bare names ambiguous across levels. Defer the durable change until a
  real need triggers it.
- **Single-folder resolution (no cross-folder references).** Rejected: deletes
  the cross-table reference feature that is the point of a table scope.
