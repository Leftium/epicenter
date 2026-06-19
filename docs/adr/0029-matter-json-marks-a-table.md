# 0029. A matter.json marks a table; matter is a declared store, not a discovered lens

- **Status:** Accepted (nesting clause reversed by [ADR-0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md))
- **Date:** 2026-06-19

> The marker rule and declared-store framing below stand. The "nesting is
> first-class: a table can contain tables" clause is reversed by
> [ADR-0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md): a
> folder is a table XOR a container of tables, never both, so a marked folder's
> subfolders are ignored rather than shown as subtables.

## Context

matter classified folders by shape (a folder of files was a table, a folder of
folders was a vault), and a folder with no `matter.json` was a valid untyped
table. Every shape-based rule hit one irreducible ambiguity: a `.md` next to a
subfolder could be a data row or a document, and a subfolder could be a table or
an attachment bundle. Shape cannot tell them apart, so every variant either
silently dropped rows (the asset-folder bug, where `pages/` with image
subfolders vanished its `.md`) or turned a root `README.md` into a row. An
earlier draft of this ADR tried "a folder is both a table and a vault"; that
relocated the ambiguity rather than removing it.

## Decision

A folder is a table **if and only if it contains a `matter.json`.** The marker is
the declaration; matter never guesses a table from shape.

- A marked folder's `.md` files are its rows.
- A marked folder's immediate child folders that are **themselves marked** are
  its subtables. Nesting is now first-class: a table can contain tables.
- An unmarked folder is not data. It is ignored (an attachment bundle, a junk
  dir, a purely organizational folder).
- Opening folder `F` shows `F`'s own rows (when `F` is marked) plus its immediate
  marked children as subtables. **No recursion:** depth is reached by opening a
  subtable. `F` itself need not be marked for its marked children to show, so you
  can point matter at an unmarked container and still see the tables inside it.
- Contract semantics:
  - `matter.json` with a valid `fields` map → a **typed** table;
  - `matter.json` with no `fields` (including `{}`) → an **untyped** table (the
    raw grid, columns from frontmatter). `{}` becomes the canonical untyped-table
    marker, replacing the old `MissingFields` error;
  - unparseable `matter.json` → a table whose contract is broken, surfaced as
    `invalid-contract` (still a claimed table, not "not a table");
  - no `matter.json` → **not a table**.

This redefines matter as a **declared store**, not a lens that auto-discovers
tables in arbitrary markdown. Reference resolution across the new nesting is
governed by [ADR-0030](0030-references-resolve-within-a-folder-and-its-immediate-children.md).

## Consequences

Dissolved, not relocated:

- the table-vs-vault shape guess;
- the "is this `.md` a row or a document" ambiguity;
- the "is this subfolder a table or an attachment" ambiguity;
- the silent `.md`-drop footgun class.

matter asks instead of guessing.

Gained:

- nesting / subtables (a marked folder inside a marked folder), expressible
  cleanly with no new noise.

Cost:

- matter no longer auto-discovers tables in un-annotated markdown. Point it at an
  existing Obsidian vault or docs repo and it shows nothing until each folder is
  adopted (one `matter.json` apiece). This is the deliberate price of removing
  the ambiguity, mitigated by an "adopt folder as table" affordance that writes
  `{}`; untyped raw grids survive through that same `{}`.

Migration:

- existing untyped tables (no `matter.json`) must gain a `{}` marker. In-repo
  that is only the `missing-model` fixture; every example table already declares
  `fields`.

Reverses:

- the "altitude is pure shape" direction and the earlier full-collapse draft of
  this ADR.

## Considered alternatives

- **Fix the classifier (a subfolder counts as a table only if it contains
  `.md`).** Keeps zero-ceremony discovery, but cannot express a folder that has
  both its own rows and child tables, and retains a narrow silent drop. Rejected
  once matter became a declared store.
- **Full collapse (a folder is both a table and a vault, shape-driven).** Never
  drops a `.md`, but turns a root `README.md` into a row and shows attachment
  folders as empty tables. Rejected: relocates the ambiguity instead of removing
  it.
- **Dotfolders only (no model change).** Zero code, but the silent `.md`-drop
  persists for anyone who does not know the convention. Rejected.

Stop-and-confirm: this removes the "works on any folder of markdown" promise.
Confirmed by the user on 2026-06-19.
