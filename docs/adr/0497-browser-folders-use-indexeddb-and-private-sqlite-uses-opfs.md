# 0497. Browser folders use IndexedDB and private SQLite uses OPFS

- **Status:** Proposed
- **Date:** 2026-10-03
- **Relates:** [ADR-0461](0461-portable-data-folders-live-under-local-and-derived-account-scopes.md) defines authored scopes; [ADR-0496](0496-native-app-runtime-storage-is-independent-of-the-shell.md) defines shell-independent native runtime ownership; [ADR-0494](0494-file-folders-reserve-epicenter-for-rebuildable-caches.md) separates optional derived caches from authored source.
- **Implementation:** one IndexedDB database per browser folder with literal file bytes, metadata, directories, and private Git state. Application SQLite already uses a separate OPFS worker.
- **Unbuilt:** captured channel/account folder addressing, corresponding lock and notification identities, channel-scoped SQL ownership, and any migration required to preserve existing namespaces. Generic folder queries and persistent query caches are unbuilt.

## Context

Browser and desktop applications need the same authored paths and bytes:
Markdown, `kv.json`, recordings, and other ordinary files. This does not require
the browser to use the desktop's physical storage mechanism.

The current browser Folder backend uses one IndexedDB database named
`epicenter-folder:<id>`. Its four object stores are `contents`, `inventory`,
`directories`, and `git`. Git's `/files` view reads those authored bytes;
`/git` is a private adapter mount, not another working copy.

Incoming publication checks the captured file baseline, index, and branch,
then writes the files, index, and branch in one transaction. Replacing this
with separate OPFS file writes would require publication journals, interruption
recovery, and mutation fences. Physical directory resemblance alone does not
justify replacing the existing transaction.

## Decision

**Authored browser folders stay in IndexedDB; private live SQLite stays with its OPFS owner.**
Desktop and browser share logical folder addresses, literal relative paths,
and exact file bytes. They do not share a physical directory or storage engine.

```text
Desktop authored folders:
  ~/Epicenter/
    local/<folder-id>/...
    accounts/<account-key>/<folder-id>/...

Browser authored folders, per origin:
  IndexedDB database for [channel, scope, account-key-or-null, folder-id]
    contents
      "kv.json"                -> exact bytes
      "notes/example.md"       -> exact bytes
      "audio/take.webm"        -> exact bytes
    inventory                  -> hashes, sizes, modification metadata
    directories                -> explicit directory records
    git                        -> private objects, index, refs

Desktop private application storage:
  <OS local-data>/so.epicenter/<app-id>/
    local/...
    accounts/<account-key>/...

Browser private application storage, per origin:
  OPFS logical namespace:
    so.epicenter/<app-id>/
      local/<logical-database>
      accounts/<account-key>/<logical-database>
```

The private SQL tree specifies logical addresses. SQLite's existing
SyncAccessHandle pool owns physical filenames. It does not promise literal
database files at those paths. Native and browser storage remain physically
separate; neither grants access to another browser origin.

| Role | Release convention | Development convention |
| --- | --- | --- |
| Authored root or logical display | `Epicenter` | `Epicenter Dev` |
| Private app/account namespace | `so.epicenter` | `so.epicenter.dev` |

Use these exact spellings, including capitalization and the space in
`Epicenter Dev`. IndexedDB has no corresponding physical root directory.
There is no additional `apps/`, `runtime/`, `device/`, or `sqlite/` prefix.
This contract creates no selected-folder registry or generic storage router.

**Capture a folder's identity once, before opening its resources.**
The address includes channel, Local or account scope, the account key or null
for Local, and folder ID. Account keys follow ADR-0461. One captured address
supplies the database, Web Lock, and notification identities. Exact encoding
and any physical renaming are implementation decisions, not a reason to
migrate an existing database merely to resemble a directory tree.

Private SQL has independent channel/app/account/database ownership. Changing
the selected authored folder cannot select, reset, or copy Mail's mailbox or
pending work. Provider credential addresses follow that private ownership;
authentication sessions remain separate from the authored namespace.

Private storage groups by app first, then uses the same `local` or
`accounts/<account-key>` scope spelling as authored folders. The app owns its
schema and pending-work lifecycle. A private app ID is independent of the
selected authored folder ID; matching their strings does not couple their
owners. Account-wide private erasure requires app-aware coordination under
either directory order.

Channel isolation covers database, lock, and hint identities, SQL worker
ownership, claims, pool directories and VFS registrations, and relevant private
credential addresses. A changed filename alone does not isolate owners.
Separate origins do not replace explicit channel separation.

**Retain one database per folder and the four current object stores.**
Metadata-only listing and stat reads avoid loading recording bytes. Git state
stays structurally separate from authored files but within the same database
so incoming publication can transact across both. Conditional saves compare
the captured hash inside the write transaction. Batches retain their existing
transactional application; ordinary saves do not promise an atomic later
automatic Git commit.

**Authored file storage preserves arbitrary exact bytes, regardless of extension.**
Markdown interpretation and validation belong above storage. Malformed text
remains readable for repair. Settings, media, and intentionally saved completed
SQLite datasets are ordinary authored files. Saving SQLite bytes does not
install a SQL driver or activate imported pending work. The application never
uses authored storage as its live mailbox or outbox database.

Logical parity does not promise that every browser filename can be exported to
every OS. Transfer validates destination names and collisions and reports
refusals; it does not silently rename or omit files. Private Git state,
credentials, and derived caches remain outside authored transfer.

**Folder queries build in memory from one immutable capture.**
Several queries may share that capture until explicit refresh or closure.
They require no saved SQLite bytes. Persistent caching requires measured
benefit. This record selects neither a private cache object store nor a
separate cache database: an object-store addition requires a version upgrade,
and a separate database needs its own lifecycle. Cache storage failures must
not prevent querying readable source. Any eventual cache stays outside source
enumeration, capture, history, transfer, and authored change notifications.

ADR-0494's future `.epicenter/` boundary and legacy root `index.sqlite3`
exclusion are planning concerns, not newly implemented filters. No cache writer
ships before its source exclusions. Legacy `.epicenter/manifest.json` retains
its existing contract until explicit conversion.

**Namespace changes preserve existing data and exclude older active owners.**
Current unscoped databases contain authored bytes and history. Do not bind an
old folder to the current login automatically, silently open an empty
replacement, or interpret missing target records as deletions. A new claim key
alone cannot exclude an older build. Require a quiesced cutover or verified
admission bridge when identities migrate. Private SQL migration also preserves
retained data and pending intents. Compatible existing release adapter names
may remain when they avoid an unnecessary migration.

Verify two channels and two authority/principal pairs on one origin; consistent
database, lock, hint, and SQL ownership; folder switching with SQL retained;
stale-save refusal; atomic incoming files/index/branch publication; and
migration preserving bytes, history, and pending intents. Real-browser checks
cover transaction lifetime, quota failure, and media capture memory and timing.

## Consequences

Logical filesystem parity retains browser transactions without an authored
OPFS adapter, publication intent journals, per-step recovery records, startup
recovery fences, or a folder-specific OPFS worker topology and migration.
Private SQLite workers and ownership admission remain necessary.

Browser storage is still origin-private and subject to quotas and site-data
deletion. This layout provides neither backup nor cross-origin sharing.
Existing account and channel bootstrap work remains; keeping the storage
backend does not implement that identity contract.

## Considered alternatives

- Authored OPFS files: provide direct file handles and a physical tree, but
  replace transactional publication with recovery machinery. Reconsider only
  if a measured media or memory problem earns that cost after evaluating the
  IndexedDB path. Ordinary async OPFS does not require a dedicated worker;
  synchronous access handles have additional worker constraints.
- One global IndexedDB filesystem: adds prefix-based scope isolation and
  couples folder deletion, upgrades, and transaction scope without a caller
  requiring cross-folder atomic operations.
- Combined metadata and bytes: deletes paired record maintenance but risks
  loading large media during metadata scans. Measure before reshaping stores.
- Markdown-only or SQLite-extension bans: lose settings, media, and intentional
  datasets without separating live application state from authored files.
- Every file inside SQLite: couples authored file authority to a database
  engine and the private application's reset lifetime.
