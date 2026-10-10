# 0520. The CLI acts on a data folder by its path

- **Status:** Proposed
- **Date:** 2026-10-11
- **Relates:** [ADR-0517](0517-a-data-folder-can-live-inside-any-repository.md) (a data folder is a directory with `epicenter.json`), [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) (queries build transient projections), [ADR-0490](0490-the-cli-discovers-folders-and-delegates-history-to-git.md) (account and Git commands)
- **Unbuilt:** the retirement of `epicenter validate` with its executable configuration. `check` and `query` are implemented in `scripts/epicenter-data-folder.ts`.

## Context

The CLI's one command that reads a data folder, `epicenter validate <folder>`,
imports and runs `<folder>/epicenter.config.ts` to learn the declaration and
parses rows with a second Markdown parser from `@epicenter/app`. Its other
local commands address managed folders by folder ID under `~/Epicenter`.

Under ADR-0517 a data folder is any directory containing `epicenter.json`, in
any repository. Running a cloned repository's TypeScript to read its data is
unsafe there, and a folder ID cannot name a data folder inside a host
repository.

## Decision

**Every command that acts on a local data folder takes its path.** A folder ID
names a cloud copy and its default directory under `~/Epicenter`; it is not an
argument for local work. When ADR-0490's Git passthrough is rebuilt, it takes a
path too, and it refuses a data folder that is not at its repository root.

**Two commands cover the file contract:**

```text
epicenter check <dir> [--json]
epicenter query <dir> [<sql>] [--json]
```

Both read `<dir>/epicenter.json` and nothing executable. Both parse every row
of every declared table with the folder package's `parseRow` and read
`kv.json` against the declared KV fields. Neither writes a file, takes a lock,
reads Git, contacts a network, or requires an account.

`check` reports declaration errors and stops. Otherwise it prints one line per
row issue, compiler style:

```text
posts/2026-10-20-launch.md:3: status: must be equal to one of the allowed values
```

It exits 0 when every row conforms, 1 when any row is invalid, and 2 when the
declaration or a file cannot be read.

`query` builds an in-memory SQLite projection under ADR-0494, makes it read-only,
and runs one statement. Without a statement it prints each table's columns,
allowed values, row count, and invalid count. The projection has:

| Table | Columns |
| --- | --- |
| one per declared table | `id` (the row's stem), `_path`, `_sha256`, each declared field, `_body` |
| `_kv` | `key`, `value` (JSON text) |
| `_invalid` | `table_name`, `_path`, `_sha256`, `line`, `field`, `message` |

Declared fields keep their names and are quoted, because field names may be
SQL keywords. The field grammar refuses `id` and names that start with `_`, so
projection columns never collide with declared fields. A null or absent value
is `NULL`, a boolean is `0` or `1`, a list or object is JSON text, and strings
and numbers are stored as they are.

Invalid rows are absent from their table and listed in `_invalid`. After a
statement's results, `query` reports how many rows each table left out and
where. It exits 0 when the statement ran and 2 when the declaration or the
statement failed.

**Account and transfer commands are a separate half.** `login`, `logout`,
`accounts`, listing cloud data folders, `get`, and the Git passthrough are the
CLI's form of an app's download and sync. They need an account and a data
folder at a repository root, and ADR-0490 governs them.

## Consequences

- `epicenter validate`, its `epicenter.config.ts` execution, and the CLI's use
  of `parseRowFile` retire. The CLI and the apps read rows with one parser.
- An agent's first call in an unfamiliar repository is `epicenter query <dir>`,
  which describes the data folder well enough to write SQL.
- Every query reads the current working tree. Pulling newer commits is the
  caller's job; `query` never changes files.
- A statement that writes is refused, so no agent can believe an in-memory
  `UPDATE` changed a row.
- Until the CLI is distributed, a caller outside the monorepo runs
  `scripts/epicenter.ts` from an Epicenter checkout.

## Considered alternatives

- **Separate nouns for data folders and synced repositories.** A synced
  repository is a data folder at a repository root with a pairing, so a second
  noun would split one concept across the surface.
- **Accepting a folder ID or a path.** Two address forms need an ambiguity
  rule for a saving of a few keystrokes.
- **A command local to one host repository.** The file contract belongs to
  every repository, not to one vault.
- **A persistent SQLite file.** It needs a location, ignore rules, and
  freshness checks; rebuilding per query is cheap at current sizes (ADR-0494).
- **`validate` with executable configuration.** It runs untrusted code to read
  data.
- **`sql` or a separate `describe` command.** `query` without a statement
  already describes the folder.
- **Write commands such as `add` or `set`.** People and agents edit the
  Markdown directly; a second write path would duplicate it.
