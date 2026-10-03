# 0497. Browser folders use scoped OPFS directories

- **Status:** Proposed
- **Date:** 2026-10-03
- **Relates:** [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored owners; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) defines private native runtime ownership; [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) defines transient query sessions.
- **Unbuilt:** production OPFS acquisition, verified IndexedDB cutover, Git incoming recovery, and application adoption. Private SQL channel ownership remains separate work.

## Context

The browser adapter stores one folder in an IndexedDB database. Its `contents`,
`inventory`, `directories`, and `git` object stores split ordinary files from
private repository paths. Incoming publication uses a database transaction.

The selected replacement stores literal files and Git together in OPFS.
Individual saves need no generic multi-file transaction. Incoming Git adoption
needs its own interruption recovery because it changes the working tree,
staging index and branch together.

## Decision

**Each browser folder occupies one scoped OPFS directory containing its files and `.git/`.**
The channel, owner and folder ID select the directory. A relative file path
selects the same authored bytes for table, KV, file and media access. Git reads
that working tree and stores repository data in its `.git/` directory.

```text
OPFS, per origin:
  Epicenter/                       release authored root
    local/<folder-id>/
      kv.json
      notes/example.md
      audio/take.webm
      .git/
    accounts/<account-key>/<folder-id>/...
  Epicenter Dev/                   development authored root
    local/<folder-id>/...
    accounts/<account-key>/<folder-id>/...
```

One portable file maps to one physical file. A save does not create a second
inventory database, content mirror or private object-ID mapping. Explicit empty
directories remain directories. Repository state stays outside portable source
enumeration, capture, transfer and file-change hints.

**Capture the address before acquiring resources.**
Channel means release or development. Owner means Local or a specific account
key under ADR-0461. One captured address determines the OPFS directory, mutation
lock, Git lock and notification channel identities. Changing login cannot
retarget an opened folder. Separate origins do not replace channel isolation.

**Individual public operations do not promise cross-file atomicity.**
ADR-0482 defines individual publication and workflow-owned recovery. Cooperating
browser writers coordinate condition checks and writes under the same scoped
lock. Native conditions remain best effort against arbitrary outside programs.
Git incoming adoption retains a separate recovery record under ADR-0474.

**Cutover preserves existing bytes and history before selecting OPFS as authority.**
Existing databases named `epicenter-folder:<id>` and their scoped equivalents
contain user data. Migration copies exact contents, explicit directories and
private Git paths; it verifies the destination before marking cutover complete.
An interrupted copy can resume without replacing different destination bytes or
interpreting absent target paths as deletions. Keep the source database until
verification and cutover are complete.

Exclude older active owners through quiesced cutover or a verified admission
bridge. A changed lock name alone cannot fence an older build. Do not assign an
old Local database to the current login or silently open an empty replacement.

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

OPFS remains origin-private and subject to quota and site-data deletion. A tree
is neither a backup nor cross-origin sharing. Migration must preserve existing
media and Git history, including repositories with no branch commit.

## Verification

Verify release/development and Local/two-account isolation on one origin;
stale captured-save refusal; exact media bytes; empty directories; quota failure;
and restart during migration. Interrupt incoming adoption before and after file,
index and branch changes and verify safe explicit recovery. Changing authored
folders must retain independent private SQL ownership.

## Considered alternatives

- Retain IndexedDB transactions: preserves cross-file atomicity but keeps a
  different physical storage model and its inventory/content pairing.
- Journal every ordinary save: adds durable operation state to workflows that
  need only one file publication and its actual reply.
- Store authored files in private SQLite: couples file authority to a database
  engine and private application reset lifetime.
