# 0497. Browser folders use scoped OPFS directories

- **Status:** Accepted
- **Date:** 2026-10-03
- **Relates:** [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored owners; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) defines private native runtime ownership; [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient query sessions.
- **Unbuilt:** application selection of development and account scopes, and private SQL channel and account ownership in the `so.epicenter/<app-id>/<owner-path>/` namespace.

## Context

The browser adapter stored one folder in an IndexedDB database named
`epicenter-folder:<id>`, or its scoped equivalent. Its `contents`,
`inventory`, `directories`, and `git` object stores split ordinary files from
private repository paths, and incoming publication used one database
transaction.

The replacement stores literal files and Git together in OPFS. Individual saves
need no generic multi-file transaction. Incoming Git adoption needs its own
interruption recovery because it changes the working tree, staging index and
branch together. Existing databases hold user files and history that must reach
the new layout intact, while a tab of an earlier build may still have one open.

## Decision

**Each browser folder occupies one scoped OPFS directory containing its files and `.git/`.**
The channel, owner and folder ID select the directory. A relative file path
selects the same authored bytes for table, KV, file and media access. Git reads
that working tree and stores repository data in its `.git/` directory, which no
folder path can name and no listing shows.

```text
OPFS, per origin:
  Epicenter/                       release authored root
    local/<folder-id>/
      kv.json
      notes/example.md
      audio/take.webm
      .git/
        epicenter-folder.json      ready marker naming the address
    accounts/<account-key>/<folder-id>/...
  Epicenter Dev/                   development authored root
    local/<folder-id>/...
    accounts/<account-key>/<folder-id>/...
```

One portable file maps to one physical file. A save creates no inventory
database, content mirror or private object-ID mapping; a file's identity is the
SHA-256 of the bytes read from it. Explicit empty directories remain
directories. Repository state stays outside portable source enumeration,
capture, transfer and file-change hints.

Opening requires `navigator.storage.getDirectory`, writable file streams and Web
Locks, and returns `NoFileSystem` without them. It also requires IndexedDB to
find a folder an earlier version saved (`NoIndexedDb`). No browser folder is
kept in IndexedDB, and opening never falls back to another store.

**Capture the address before acquiring resources.**
Channel means release or development. Owner means Local or a specific account
key under ADR-0461. One captured address determines the OPFS directory, the
files and Git Web Lock names and the notification channel. Changing login cannot
retarget an opened folder. Separate origins do not replace channel isolation.
Omitted scope opens release Local; applications choose any other scope
explicitly.

**Individual public operations do not promise cross-file atomicity.**
ADR-0482 defines individual publication and workflow-owned recovery. Every file
mutation holds the folder's files Web Lock, so cooperating tabs check and
publish conditions without interleaving. New bytes publish when a file's
writable stream closes. A stream whose close throws is `Unconfirmed`, whatever
the path holds afterward. Git incoming adoption retains a separate recovery
record under ADR-0474.

**The IndexedDB adapter is retired; an earlier database is a read-only migration source.**
The first open of an address copies its database into the directory once,
under an open Web Lock:

1. Freeze. Open the database at a version earlier builds cannot open. Their
   connections close on `versionchange`; one that does not let go is
   `LegacyInUse`, and nothing is copied.
2. Read the frozen database, not an observation taken before freezing.
3. Copy files, explicit directories and `.git` files byte for byte. Equal bytes
   are kept and missing entries written; an entry with other bytes, empty
   included, refuses the copy. Before creating a file, commit a cursor naming it
   to the frozen database's `migration` store, and clear it once the file reads
   back. A resumed copy rewrites only an empty file its cursor names.
4. Verify that the directory topology is exactly the database: every file, every
   explicit directory and every ancestor directory its files imply. Then write
   the ready marker `.git/epicenter-folder.json` naming the address.

A copy that stops or does not verify is `LegacyMigration`, and opening again
resumes it. The `contents`, `inventory`, `directories` and `git` stores are
never written and remain the backup. A directory without a ready marker for its
address is never opened as a folder. A tab of an earlier build keeps showing
what it read, and its later writes fail.

**A scoped folder opens only past a fence on release Local.**
A development or account folder with nothing of its own starts only when the
release Local folder of the same ID is ready, or when the earlier builds' Local
database is frozen and holds nothing. Freezing applies even to an absent
database, so no earlier build can start a Local folder beside the scope
afterward. A Local database that holds data refuses the scope with
`LegacyScopeUnassigned`; an earlier tab that holds it refuses with
`LegacyInUse`. Neither creates a folder. A frozen Local database whose copy
never finished is not a claim. Opening never assigns Local data to the current
login and never opens an empty replacement for it.

**Private application SQLite retains independent channel, app and account ownership.**
Its OPFS namespace is `so.epicenter/<app-id>/<owner-path>/` for release and
`so.epicenter.dev/<app-id>/<owner-path>/` for development. SQLite's access-handle
pool owns physical filenames. Selecting an authored folder cannot select,
reset or copy a mailbox, outbox or pending provider work. Credentials follow the
private owner; authentication sessions remain separate.

**Authored storage preserves arbitrary exact bytes.**
Markdown validation belongs above storage. Malformed text remains readable for
repair. Saved completed SQLite datasets are ordinary authored files; they do
not activate a SQL driver or imported pending work. Transfer validates target
names and collisions without silently renaming or omitting files.

Folder queries build in memory from immutable captures under ADR-0494. This
layout reserves no folder-local cache directory. A future persistent cache must
have a measured caller and stay outside source capture, history and transfer.

## Consequences

The browser and native adapters expose the same literal file model. Browser
saves lose IndexedDB's cross-file transactions. Incoming Git recovery pays for
its own durable record instead of imposing a journal on every save.

OPFS remains origin-private and subject to quota and site-data deletion; quota
exhaustion and eviction surface as the failing step's `Io` or `Unconfirmed`.
A tree is neither a backup nor cross-origin sharing. The adapter makes no
power-loss or flush-to-disk promise, and OPFS offers no compare-and-swap:
cooperating tabs rely on the files Web Lock. Pages of other origins or browser
profiles are outside what the locks and the migration can see.

Every earlier database stays on disk after migration, so its bytes count
against quota until site data is cleared.

## Verification

The browser production opener passes its OPFS checks in Chrome, and a reloaded
page reads what it saved. Each browser application opened in Chrome over data
an earlier build saved in IndexedDB, with its files and Git history preserved
and ordinary saves surviving reload. The package suites run on an in-memory
OPFS stand-in with fake IndexedDB; they establish the protocol, not that every
browser's OPFS behaves like the stand-in.

Still to verify: quota failure in a real browser, restart during migration in a
real browser, and release/development and Local/two-account isolation once
applications select those scopes.

## Considered alternatives

- Retain IndexedDB transactions: preserves cross-file atomicity but keeps a
  different physical storage model and its inventory/content pairing.
- Journal every ordinary save: adds durable operation state to workflows that
  need only one file publication and its actual reply.
- Store authored files in private SQLite: couples file authority to a database
  engine and private application reset lifetime.
- Keep both adapters as a runtime option: two physical layouts would each need
  migration, locking and recovery, and an older build could keep writing the
  store the newer one left.
