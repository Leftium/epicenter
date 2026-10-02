# 0497. Browser folders use OPFS with recoverable publication

- **Status:** Proposed
- **Date:** 2026-10-03
- **Relates:** [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored scopes; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) defines shell-independent native runtime ownership.
- **Unbuilt:** OPFS Folder adapter, publication recovery, production browser migration, and shared browser runtime admission. Current Folder files and Git state use IndexedDB; application SQLite already uses an OPFS worker.

## Context

The current browser Folder backend holds literal file bytes, inventory, and
private Git state in IndexedDB. Application SQLite uses a separate OPFS
backend. File APIs need not imply IndexedDB: OPFS supports ordinary files and
directories alongside SQLite-managed storage.
See the [OPFS API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system)
and [SQLite browser persistence](https://sqlite.org/wasm/doc/trunk/persistence.md).

IndexedDB currently publishes related file records and Git state in one
transaction. Replacing that backend with ordinary filesystem operations loses
that multi-file transaction. Existing filesystem prototypes tested ordered
publication and recovery on IndexedDB-backed filesystems; they do not verify
an OPFS implementation or establish a net code reduction.

## Decision

**The browser Folder target stores authored files and Git state in OPFS.**
Markdown, `kv.json`, and media remain ordinary file bytes. SQLite remains an
optional derived projection or a justified transactional database; it does not
become the authoritative container for every authored file.

The origin's release root has this logical layout:

```text
OPFS/epicenter/
  local/<folder-id>/
    kv.json
    recordings/take.md
    recordings/take.opus
    .git/...
    .epicenter/query.sqlite3       optional rebuildable projection
  accounts/<account-key>/<folder-id>/...
  runtime/<app-id>/<account-owner>/
    local.sqlite3                 retained pending work
    mail-<google-sub>.sqlite3      downloaded mailbox
```

Development uses a separate `epicenter-dev` root. Account keys and owners use
ADR-0461 and ADR-0496. `runtime/` earns its boundary here because the OPFS root
contains authored scopes as well as private application state. There is no
additional `apps/` prefix. Moving or exporting a source folder excludes runtime
state and its optional `.epicenter/` cache.

Authored relative paths and bytes match a desktop data folder. OPFS is
origin-private, not a user-visible desktop directory or a grant to another
origin. Export materializes authored paths; it does not expose the browser's
runtime root. Native and browser databases remain physically separate.

The tree specifies logical addresses. SQLite's existing access-handle pool
manages physical files internally; its synthetic database names do not promise
literal OPFS filenames. A cache stays outside the authored file boundary even
when its logical address is beside the folder. No query database is created
until a consumer needs it; reuse validates source and definition interpretation.

**One admitted owner serializes each protected resource's operations.**
Tabs cannot bypass conditional-save checks, publication, or Git admission.
Runtime admission protects the app/account SQL lifetime and its provider
executor. Folder ownership is separate: changing an authored folder cannot
select another Mail outbox. Dedicated-worker synchronous OPFS access and
cross-tab admission need a verified topology; a SharedWorker by itself does
not establish that synchronous access is available.

**Interrupted multi-file publication is recoverable and never reported as complete.**
Persist recovery intent outside authored files before publication. Record
completed steps, preserve newer conflicting edits, and fence ordinary mutations
until interrupted publication is resolved. Git working files, index, and branch
must recover as one admitted operation even if their writes are ordered.
Single-file conditional saves retain their captured-byte checks. No generic
multi-file atomicity promise is added.

Migration must verify these guarantees on OPFS before replacing production
IndexedDB. Exercise two-tab stale saves, interrupted file and Git publication,
worker restart, quota failure, and conflicting recovery. Migration preserves
authored bytes and history; it cannot treat missing target files as deletions.
No dual authoritative writer remains after cutover.

This decision replaces browser Folder persistence, not every use of IndexedDB
across authentication or legacy Yjs stores. Credentials and login sessions do
not move into authored files or OPFS runtime databases through this decision.

## Consequences

Browser and desktop folders share a file representation. Removing the
IndexedDB file backend can remove its inventory/content storage translation,
but OPFS does not remove admission or recovery. Measure the resulting production
code and media handling before claiming simplification or improved performance.

Browser site-data deletion still removes authored files and pending work. OPFS
is subject to browser storage quotas and persistence policy; changing backends
does not provide backup or cross-origin sharing.

## Considered alternatives

- Keep IndexedDB files plus OPFS SQL: preserves current transactional publication
  but retains two browser persistence backends for folder applications.
- Put every file and runtime table in one SQLite database: supplies transactions
  but makes SQLite an authoritative file container and couples reset lifetimes.
- Write OPFS files without recovery: leaves interrupted Git or multi-file saves
  without an admitted resolution path.
- Require literal SQLite files at every logical path: conflicts with the current
  pool adapter without improving authored export or SQL ownership.
