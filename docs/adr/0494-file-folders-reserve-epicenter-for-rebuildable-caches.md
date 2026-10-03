# 0494. File folders reserve .epicenter for rebuildable caches

- **Status:** Proposed
- **Date:** 2026-10-03
- **Relates:** [ADR-0436](0436-stores-own-local-sqlite-namespaces.md) defines current store-owned SQL; [ADR-0459](0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) separates authored files from application SQL; [ADR-0463](0463-queryable-exports-contain-completed-sqlite-snapshots.md) defines completed query exports.
- **Unbuilt:** reserved-path enforcement, managed-folder ignore initialization, folder-derived query caches, SQL export, and file-first Mail resource composition. Current Personal SQL acquisition and AppData/OPFS paths remain implemented.

## Context

A file-authoritative folder saves Markdown rows, `kv.json`, and attachments.
A derived query database can accelerate reads of that folder. Local Mail also
holds downloaded Gmail data and pending edits, but those databases are keyed
by the captured Epicenter account, application, and Google subject. Selecting
another saved-query folder must not select another mailbox or outbox.

Mail currently borrows Personal's SQL namespace. Its durable `local` database
holds connected accounts, pending edits, revision counters, and delivery
reports. Each `mail-<sub>` database holds downloaded mail and checkpoints.
Saved queries remain Yjs Personal rows. No file-folder query consumer or SQL
export generator is implemented.

The proposed `.epicenter/cache/` and `.epicenter/state/` tree put unrelated
lifetimes under one authored folder. It would make a folder copy carry
executable pending work. A separate root `index.sqlite3` also required filename
exclusions without an implemented reader or generator.

Legacy Yjs working copies already use `.epicenter/manifest.json` as their
reconciliation baseline. That existing contract is not a disposable cache.

## Decision

**In file-authoritative folders, root `.epicenter/` is reserved for optional, rebuildable folder-derived caches.**
The directory contains no authored preferences, credentials, provider mirrors,
pending actions, or original unfinished recordings/downloads. A native query
cache, when a real indexed-query consumer needs one, uses the flat path
`.epicenter/query.sqlite3`. Do not eagerly create a database or add `cache/`,
`state/`, `logs/`, or `tmp/` directories without consumers and separate reasons.
Any temporary cache-generation bytes must also be reconstructable from source.

The first folder query implementation captures source and its selected definition
and builds an in-memory projection. A single query releases it after execution;
an explicit query session may run several queries against the same immutable
capture before refresh or closure. Results describe that capture, not a promise
that the live folder remains unchanged. Refresh creates a new capture and
projection. Writes based on results retain the source's conditional-save checks.
The transient connection is owned separately from app/account SQL lifetimes.
Change hints may mark a session stale; they do not prove freshness. Persistent
reuse requires a measured benefit over capture and projection, not merely a
reserved filename.

The query cache belongs to one data folder and its definition interpretation,
not to an application installation or account profile. Native persistence uses
that folder's `.epicenter/query.sqlite3`; browser persistence uses the same
address under ADR-0497. Cache placement does not require a particular SQLite VFS.
An in-memory projection needs no file. Colocation follows the selected folder
without a separate cache-address registry, but the database is never required
to recover its source. A copied cache is reusable only after validation.

If persistence earns its place, prefer a completed standalone snapshot over a
live mutable cache. Build from captured bytes, then publish database bytes at the
same cache address. Browser readers can load those bytes into memory without a
folder-cache SAH pool; native readers must detach bytes or coordinate connection
closure before replacement. Serialization, memory use, and recovery require
verification before this strategy ships. Mail's private SQL pools are unaffected.

Reuse validates source content, definition interpretation, and projection/build
version. Schema equality alone is insufficient. Missing, stale, corrupt, or
unwritable cache storage must not by itself prevent querying readable admitted
source. Cache rebuild and publication never mutate authored files.

Queries describe the immutable bytes captured for that run. Folder admission
orders the owner's operations; it does not freeze external editors or establish
an atomic whole-folder observation. Unreadable or disappearing files must be
reported. The public projection schema and malformed-row policy must be settled
before implementation; silently dropping rows is not a complete query result.

The source path boundary reserves a first segment equal to `.epicenter` ignoring
ASCII case. This is a root-only reservation: `notes/.epicenter/` is not reserved
by this record. It changes no spelling of authored paths. Source `files` reads,
writes, enumeration, terminal access, history capture, change hints, and
incoming adoption refuse or skip the reserved root subtree as appropriate.
Enumeration skips it before descent, reading, hashing, linking, or copying.
Ignoring extensions after capture is not this boundary.

The cache owner accesses the subtree through its own implementation boundary.
It fences operations and closes affected connections before resetting a cache.
Existing or incoming tracked `.epicenter/` paths are refused rather than silently
dropped from a commit. Explicit conversion is required before adopting such a
folder under the new contract.

Browser caches are scoped to the selected browser origin and folder identity,
outside the authored source boundary. No browser SQL cache is required until
a query consumer needs one. A native or browser cache
must validate the source it projects and its definition interpretation before
reuse. Presence at the right path does not prove freshness. Refresh scheduling,
query schema, and source-validation machinery remain unbuilt; no continuous
watcher, whole-folder version API, or direct-cache-reader contract is promised.
No implementation may write cache bytes until that implementation excludes
`.epicenter/` from source capture, history, and transfer. A Git ignore entry alone
does not satisfy this ordering.

**Application/account working state remains outside authored folders.**
Mail's mailbox mirrors and durable outbox keep the captured app/account runtime
as their owner. Changing the saved-query folder does not move or duplicate them.
Current native files stay in AppData and browser SQL stays in OPFS. No generic
`folder.sqlite` capability or `.epicenter/state/` namespace is introduced.
Ordinary preferences and saved queries move to file authority when their
consumers migrate, independently of SQL's retained state.

The file-first target separates these owners:

```text
selected Mail source folder/
  kv.json
  savedQueries/query1.md
  .gitignore
  .epicenter/
    query.sqlite3                  only if an indexed-query consumer needs it

captured app/account SQL namespace/  AppData on desktop, OPFS in browser
  local.sqlite                      retained accounts and pending work
  mail-<google-sub>.sqlite           downloaded mailbox and checkpoints

chosen export destination/
  query.sqlite3                     completed snapshot; optional owned media
```

File-first product resource composition must acquire the source folder and
app/account SQL lifetime under one captured account. The low-level SQL owner
already supports that identity, but a replacement for borrowed
`personal.sqlite` acquisition is unbuilt. Do not retain an empty Yjs store
solely to acquire SQL, manufacture a source folder for SQL-only work, or weaken
connection fencing. Public opener design remains separate from this location
decision.

**New application-managed SQLite files use `.sqlite3`, and managed folders ignore SQLite and its companions by default.**
Managed folder creation writes the following `.gitignore` defaults as source.
Ordinary opening does not rewrite an existing ignore file. Applying defaults
to an existing folder is explicit and preserves user rules and exceptions.
This initialization is unbuilt.

```gitignore
/.epicenter/
*.sqlite
*.sqlite3
*.sqlite-wal
*.sqlite-shm
*.sqlite-journal
*.sqlite3-wal
*.sqlite3-shm
*.sqlite3-journal
```

`.sqlite` remains covered for existing files. `.db` is not the new convention
or a blanket exclusion. An intentionally saved SQLite dataset outside
`.epicenter/` may have an explicit ignore exception. Existing tracked SQLite
files remain tracked until explicitly removed from inclusion. An ignore rule
does not make retained SQL safe to delete, and an extension change does not
migrate current paths or internal adapter databases.

**Working caches and completed exports use the single default name `query.sqlite3`.**
Export generates a standalone database at an explicit destination under
[ADR-0463](0463-queryable-exports-contain-completed-sqlite-snapshots.md). It
requires no reserved file at the live folder root. The cache and export can
share projection code; their names do not define different SQL schemas.
Authored files remain the saved authority. Copying arbitrary live cache bytes
is not an export operation.

**The new reservation does not reinterpret legacy `.epicenter/manifest.json`.**
Legacy checkout readers and writers keep their existing manifest semantics.
A file-authoritative opener must identify a known legacy manifest and refuse
silent adoption until explicit conversion preserves source and retires the
legacy owner. It must not delete the manifest as cache or globally apply this
record to old checkouts. Conversion and reserved-path enforcement are unbuilt.

## Consequences

Folder-derived caches follow their source without choosing a separate cache
address for every selected native directory. A source copy works without the
cache. A raw copy can include a stale cache, so validation is still necessary.
Flat `.epicenter/` supplies one source boundary; it does not justify an index
before a query consumer demonstrates the need.

A Mail source-folder copy does not back up pending triage or downloaded offline
mail. Those runtime bytes need a separate backup. Restore and execution-owner
admission remain necessary in any location; AppData does not solve duplicate
or stale delivery after a raw database copy. Provider reset recovers only what
Gmail still retains. Atomic assertion, revision-checked retirement, and refusing
account removal while work is owed remain Mail requirements.

This removes the planned universal per-folder SQL namespace and cache/state
taxonomy. It does not remove SQL lifecycle ownership. Current `.epicenter/`
paths are ordinary source in the file-folder engine until enforcement ships.
Current root `index.sqlite3` exclusions remain implementation debt to remove
with their tests; this documentation change does not remove them.

## Considered alternatives

- Self-contained `.epicenter/cache/` and `.epicenter/state/`: keeps more app
  bytes together, but couples account/provider work to a selected source folder.
  A fixed one-folder Mail product could choose it, accepting that raw copies
  carry mailbox data and executable obligations. That is a product constraint,
  not a general folder default.
- All caches in runtime storage: simplest for current callers and valid for a
  future implementation. Arbitrary source roots still need a cache-address and
  validation policy; folder-local placement is an optional convenience.
- `.local/`: names locality rather than the owner and duplicates Local scope
  vocabulary. `.epicenter/` identifies who manages the optional cache.
- `.git/epicenter/` for pending work: resetting history could destroy the only
  copy of undelivered actions.
- Root `index.sqlite3`: adds a second canonical filename and source exclusion
  without a demonstrated discoverability requirement. Explicit query exports
  retain sharing without a permanently reserved root file.
