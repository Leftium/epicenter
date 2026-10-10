# Shared-folder workflow: findings

An experiment, not a design. It runs one narrative against a real temporary
directory and asserts every claim against bytes read back with `node:fs`.

- Script: `packages/folder/evidence/shared-folder-workflow.ts`
- Baseline: `b080da2db6`. No production source was changed.
- Result on 2026-10-02, Bun 1.3.14, macOS (APFS): **87 assertions passed, 0 failed**.
- Result on 2026-10-11, after the row-API clean break (ADR-0515), Bun 1.3.14,
  macOS (APFS): **70 assertions passed, 0 failed**. See "Retired on
  2026-10-11" below.
- Result later on 2026-10-11, after plain YAML rows (ADR-0519) and KV set
  (ADR-0522): **67 assertions passed, 0 failed**.

```sh
bun packages/folder/evidence/shared-folder-workflow.ts   # exit 0; prints every file state and assertion
```

The package typecheck includes the script.

## Setup

Two definitions share the folder ID `so.epicenter.todos` and the table name
`todos`, and are opened one after the other over the same directory with
`openFolder` from `@epicenter/folder/bun`. Only one handle is open at a time.

| | Table `todos` fields | KV keys |
| --- | --- | --- |
| App A | `title: string`, `done: boolean` | `theme: string`, `sortBy: string`, `pageSize: number` |
| App B | `title: string`, `priority: number` | `density: string`, `showArchived: boolean`, `pageSize: string` |

The agent is `writeFile` into the same directory. It never holds a handle.

## Retired on 2026-10-11

The row-API clean break (ADR-0515) removed `table.update`, comment-preserving
row patches, and the flat snapshot with partial `fields`, `issues`, and
`parseError`. A row read is now a `StoredRow` or an `InvalidRow` that carries
only the exact text, its hash, and the issues; every table save after
`create` is a guarded `replace` of a complete row, written as canonical text.
These claims were retired with it and their assertions deleted from the
script:

- B adding `priority` with a one-line patch that left the agent's comment and
  quoting byte for byte (2–3), and B's `InvalidValues` for assigning `done`
  (3). B now reads the agent's row as `InvalidRow` naming `priority`.
- A ticking `done` by changing only that value span (4). The guarded replace
  now writes canonical text: the unknown `estimate` key and the body survive;
  the agent's comment and hand quoting do not.
- Partial reads of an invalid row: the healthy `title` and body beside the
  `done` issue, and updating `title` around `maybe` (7). Repair is a guarded
  replace of a complete row.
- `Unparsed` refusals of structured updates (8, 9). Raw-text repair now goes
  through `files.replace(invalidRow, text)`, checked first with `parseRow`.
- A table receipt that is the submitted text, a later update keeping the BOM
  and CRLF, and the unpaired-surrogate receipt equal to the disk text (11).
  The table now refuses an unpaired surrogate as `InvalidValues` and writes
  nothing; exact bytes are saved through `files.replace`.

### KV, retired 2026-10-11

The KV clean break (ADR-0520) replaced `kv.create`, `kv.update`, and
`kv.inspect` with `kv.set(key, value)`, which creates `kv.json` when it is
missing and always writes the format a Git merge writes: keys sorted,
two-space indentation, each untouched value kept as its raw text. Text that is
not one strict JSON object is a `get()` error, `InvalidKv`, not a snapshot.
These claims were retired with it and their assertions deleted or rewritten:

- retired 2026-10-11: `update` on a missing file is `NotFound`, and a second
  `create` is `Exists` (5). The first `set` creates the file.
- retired 2026-10-11: B's update appended one member and reused the agent's
  indentation, and the agent's spacing around `1.50` survived (6). A set
  rewrites the file in the merge format; the agent's `1.50` spelling survives,
  its spacing and tab do not.
- retired 2026-10-11: a snapshot with `parseError` and the exact source, an
  `Unparsed` update, and `kv.inspect(text)` reading a repair (6c). `get()` and
  `set()` are `InvalidKv` carrying the exact text and its issues; the repair
  is `files.replace(invalidKv, text)` followed by `get()`.
- retired 2026-10-11: the default merge hiding an unreadable `kv.json` (6c,
  hazard below). An unreadable file is now an error, not values to merge.

The KV assertions in 5–6c were rerun against `kv.set` on 2026-10-11 and all
passed.

## What was observed on 2026-10-02

| # | Scenario | Outcome |
| --- | --- | --- |
| 1 | A creates `todos/milk.md` with title, done, body | Receipt source and hash equal the bytes on disk. |
| 2–3 | Agent adds a comment, hand quoting, and an unknown key; B reads and adds `priority` | B's `fields` holds only `title`. `done` and `estimate` are neither fields nor issues. B's `update` inserted exactly one line, `priority: 2\n`; removing that line gives back the agent's text byte for byte, body included. |
| 3 | B tries to assign `done` | Type error, and `InvalidValues` at run time. Nothing written. |
| 4 | A reads again and ticks `done` | A sees its two fields, no issue for `priority`. Only the value span of `done` changed. |
| 5 | KV with no file | `get()` is `Ok(undefined)`; defaults are the application's. `update` is `NotFound`. Reading, defaulting, a refused update, closing, and opening as B all left `kv.json` absent. `create({ theme })` wrote only that key. A second `create` is `Exists`. |
| 6 | Divergent KV schemas | B reads none of A's keys. B's `update` appended one member and reused the agent's indentation. A's `update` changed one value span. The agent's `1.50` and its spacing survived both. B assigning `theme` is `InvalidValues`. |
| 6b | Both declare `pageSize`, with different types | A's number is a field issue for B and is left out; B falls back to its default. B can then save a string there, and A has the issue instead. Nothing arbitrates. |
| 6c | Agent leaves a trailing comma in `kv.json` | Snapshot with `parseError`, exact source, no values. `update` is `Unparsed`. `files.replace(snapshot, text)` repairs; `kv.inspect(text)` reads the repair. |
| 7 | Agent writes `done: maybe` | Parses. `title` and body are available, `done` is left out with one issue. Updating `title` succeeds and leaves `maybe` alone. Updating `done` repairs it. |
| 8 | Agent writes `title: [Buy milk` | Still listed. Snapshot with `parseError`, exact source, no fields, no body. `update` is `Unparsed`. `replace(snapshot, text)` repairs. |
| 9 | Agent writes Markdown with no fences | `parseError`; not read as a body; nothing inserts fences. Body-only `update` is `Unparsed`. `replace` repairs and can keep the agent's text as the body. |
| 10 | Agent edits between A's read and A's save | `replace` is `Conflict` with the expected and actual hashes. Disk is exactly the agent's text: no write, no retry. Baseline, candidate, and disk text are all in hand after one more `get()`. The handle heard no hint for the agent's write. |
| 11 | BOM, CRLF, decomposed and precomposed é, an astral emoji, no final newline | Disk bytes are the UTF-8 of the submitted string; receipt source and hash match them; nothing was normalized. A later `update` kept the BOM and every CRLF. For an unpaired surrogate, the receipt equals the disk text (U+FFFD), not the submitted string. |
| 12 | Agent creates `todos/.hidden.md`, `todos/trailing .md`, `todos/.md` | All three are listed with their literal stems, read by `get(stem)`, and saved in place by `update(stem)`. `shout.MD` and `nested/deep.md` are not rows but are in `files.list()`. |

## What a consumer had to write on 2026-10-02

**An agent or editor that does not load the package** makes no calls. It must
know four facts: a row is `<table>/<stem>.md`; it opens with a `---` line, has a
YAML mapping, and closes with a `---` line; `kv.json` is one strict JSON object;
keys it does not recognize belong to someone and stay. Its writes are
unconditional. The applications' conditional saves protect the agent's edits
(scenario 10); nothing protects an application's edit from the agent.

**A second application** on someone else's rows:

| Task | Calls | Branches the caller writes |
| --- | --- | --- |
| Open | `openFolder({ root, definition, git: { author } })` | 1: the open refusal |
| Read a row | `get(stem)` | 4: read error, `undefined`, `parseError`, and a type check on each field it uses |
| Add or change its own field | `update(stem, { fields })`, with no read first | By `error.name`. The ones seen here: `NotFound`, `Unparsed`, `InvalidValues`, `Conflict` |
| Read settings | `kv.get()` and a one-level merge with its defaults | 2: read error, and `parseError` if it wants to say so |
| Set a setting | `kv.update(values)`; on `NotFound`, `kv.create(values)`; on `Exists`, `kv.update` again | 2, across 1 to 3 calls |
| Repair a row | `get` then `replace(snapshot, text)` | 1 |
| Repair `kv.json` | `get`, `files.replace(snapshot, text)`, `kv.inspect(text)` | 1 |
| Recover from a stale save | `get` again, then its own decision | 1 |

The read side is small because the snapshot is flat. Adding a field to a row
another application created was one call with no preceding read and no
knowledge of the other schema. That is the result the design is for, and it
held byte for byte.

## Collapse candidates

None is recommended on this evidence. Each is stated with what it would
delete, the invariant that would replace the current one, and its cost.

### 1. Let `kv.update` create the file

2026-10-11: taken by the KV clean break (ADR-0520). `kv.set` creates the file
and re-applies itself when it loses a race.

- **Deletion prize:** `kv.create`, the `NotFound` and `Exists` outcomes of KV
  saves, and the update/create/update sequence in every application that
  saves a setting.
- **Replacement invariant:** `kv.json` exists only after a save that assigned
  a value. Reads, defaults, and opening never create it. Scenario 5 would
  still pass except for its `NotFound` line.
- **Cost:** it reverses ADR-0487. Two applications creating at once means
  either an internal second attempt, which the package refuses everywhere
  else, or an `Exists` the caller still branches on, which deletes nothing.
  A `kv.json` an agent deleted on purpose would come back holding one key.
- **Evidence:** the sequence costs 1 to 3 calls and 2 branches. One
  application writes it today: Whispering's `saveSettings`
  (`apps/whispering/src/lib/library.svelte.ts:1752-1754`) calls `kv.update`,
  falls to `kv.create` on `NotFound`, and runs the pair a second time on
  `Conflict`. No other application under `apps/` calls either method. An
  earlier version of this note said no application did; that came from a
  truncated search and was wrong.
- **Recommendation:** keep. One caller is not duplication, and its retry on
  `Conflict` is that application's own policy, which an upsert in the folder
  would not remove. Revisit when a second application writes the same
  sequence. No KV change follows from this run.

### 2. Drop `tables.<name>.replace` in favor of `files.replace` and `inspect`

2026-10-11: overtaken by the row-API clean break (ADR-0515). `tables.<name>.replace`
now takes a complete row; raw text goes through `files.replace` and `parseRow`.

- **Deletion prize:** one table method and `TableReplaceError`. KV already
  repairs this way, so rows and KV would repair alike.
- **Replacement invariant:** a complete-text save returns a bare capture; how
  the text reads is always a separate `inspect` of the submitted string.
- **Cost:** this run called the table method five times. Each of the four
  that succeeded used the returned reading, and one receipt went straight
  into the next save.
  With a bare capture the caller reassembles `{ ...capture, source,
  ...inspect(source) }` itself, and gets the unpaired-surrogate case wrong
  unless it decodes its own bytes (scenario 11). The row-membership check
  goes too.
- **Recommendation:** keep. The asymmetry is real and costs KV repair one
  extra call (6c); that is cheaper than moving receipt assembly into callers.
  Adding `kv.replace` would remove the asymmetry by growing the surface, which
  this evidence does not justify.

### 3. Put the current text on `Conflict`

- **Deletion prize:** the one `get()` after a refusal in scenario 10.
- **Cost:** the refusal path would read and decode a file. A file that is not
  UTF-8, or that changed again, turns one refusal into two outcomes. The
  `actualSha256` already lets the caller confirm its reread is the version
  that refused it, which scenario 10 asserts.
- **Recommendation:** keep.

## Limits of this experiment

- **One handle at a time.** The applications are opened sequentially. Two
  live handles, and the race window inside a conditional save, were not
  exercised. The README calls on-disk checks best effort; this run does not
  measure how good.
- **One filesystem.** macOS on APFS. A trailing-space name, the empty stem,
  and `.MD` beside `.md` may behave differently elsewhere.
- **Directory entry only.** Nothing here says anything about browser storage,
  the desktop owner, or sync between devices.
- **No history.** `commitOnEdit: false`; no commit, fetch, or pull ran.
- **No watching.** A directory handle hears nothing about the agent's writes
  (asserted in scenario 10), so an application on this entry learns of them
  only by reading again.
- Not part of `bun test`. The retained script lives under `evidence/` and is included by the package typecheck.

## Hazards the run surfaced

These are properties of sharing files without a shared registry, not defects
the package can fix by itself.

- **A key two applications declare differently has no owner** (6b). Each sees
  the other's value as an issue and falls back to its default; either can
  overwrite it. The same holds for a table field.
- **A whole-text repair by one application can drop another's field** (9). B
  rebuilt the frontmatter with what it knew, and A then had an issue for
  `done`. Since 2026-10-11 an `InvalidRow` carries text, not fields, so its
  table repair keeps only the fields the repairing application writes: A's
  repair in 7 drops `priority`. A valid row's unknown keys survive a replace (4).
- retired 2026-10-11: an unreadable `kv.json` is now `InvalidKv` from `get()`,
  so there are no values to merge over defaults. Historical text:
  **The documented default merge hides an unreadable `kv.json`** (6c). With a
  trailing comma in the file, `{ ...DEFAULTS, ...snapshot.values }` showed A
  the default theme while its stored theme sat in the source. Telling the two
  apart is the caller's obligation: it has to show `parseError` and `issues`
  beside the merged values. Whispering does, through `settingsProblem`, which
  its settings form renders as a `kv.json:` alert.
- **Opening writes.** The directory opener requires an author and leaves a
  `.git` directory in the folder, asserted at the end of the run. A consumer
  that only wants to read someone's folder still does both.

## Open questions

1. Should a read-only consumer be able to open a directory without
   initializing Git in it?
2. Is a same-named key with two declared types something the folder should
   report across applications, or is naming discipline the answer?
3. Does a second live handle on the same directory behave like the sequential
   case? That needs its own run.
