# Browser folders: OPFS-only clean break

Date: 2026-10-04. Delegated work in the independent clone
`/private/tmp/folder-clean-break-20261005`, branch
`braden-w/app-schema-derive-export-import`, HEAD `13f7c93559` plus the
coordinator's transferred package paths. Nothing was committed. Edits are
limited to `packages/folder/**`.

## Decision

The user chose a clean break. A browser folder is an OPFS directory and
nothing else. IndexedDB is not required, read, written, frozen, or removed.
A folder an earlier version kept in IndexedDB is not opened or copied. There
is no compatibility fallback, legacy migration, or deletion utility.

## Files read before analysis

```txt
AGENTS.md
.agents/skills/
|-- post-implementation-review/SKILL.md
`-- rethink/
    |-- SKILL.md
    `-- references/clean-breaks.md
packages/folder/
|-- README.md
|-- package.json
|-- tsconfig.json
|-- src/
|   |-- browser.ts
|   |-- browser-adapter.ts
|   |-- browser-migration.ts            (deleted)
|   |-- browser-store.ts                (deleted)
|   |-- opfs-store.ts
|   |-- errors.ts
|   |-- contract.ts
|   |-- index.ts, boundary.ts, tauri-adapter.ts   (stale comments)
|   |-- opfs.test-support.ts
|   |-- browser-storage.test-support.ts
|   |-- legacy.test-support.ts          (deleted)
|   |-- web-locks.test-support.ts
|   |-- browser-migration.test.ts       (deleted)
|   |-- browser-scope.test.ts
|   |-- browser-opfs.test.ts
|   |-- entries.test.ts
|   |-- observers.test.ts
|   |-- browser.test.ts
|   |-- definition.test.ts, close.test.ts, merge.test.ts,
|   |   incoming-attributes.test.ts, native.test.ts, tauri.test.ts,
|   |   files.test.ts, source-scope.test.ts, terminal.test.ts,
|   |   ownership.test.ts, table.test.ts
|   `-- git/
|       |-- history-attempt.test.ts
|       `-- opfs-incoming.test.ts
`-- evidence/
    |-- opfs/main.ts, serve.ts, ACCEPTANCE.md
    |-- bundles/bundles.test.ts
    |-- edit-handle/canonical-callers.md
    |-- kv-merge-iteration/README.md, review.md      (searched only)
    |-- browser-relationship.md                      (header and search)
    `-- ../prototypes/filesystem/*                   (searched only)
apps/ (searched only, for callers of removed names)
```

## Findings before edits

1. `browser-adapter.ts` made `indexedDB` and `IDBKeyRange` an open
   precondition (`NoIndexedDb`). Reading the globals also meant a page whose
   IndexedDB accessors throw could not open an OPFS folder.
2. The only owner of OPFS identity (a ready marker naming the address,
   refusing entries nothing explains) was inside `browser-migration.ts`, and
   it worked only through the IndexedDB freeze and copy. Deleting the
   migration left no identity check, so the adapter needed its own small one.
3. `localFence` held scoped opens behind the release Local database
   (`LegacyScopeUnassigned`, `LegacyInUse`). This is the release-Local legacy
   fence the user asked to remove.
4. `NoFileSystem` had no test. Marker identity (wrong address, unexplained
   entries) was tested only inside the legacy suite.
5. Test fixtures keyed each stand-in OPFS tree off an `IDBFactory` through a
   `WeakMap`, so every browser suite built fake IndexedDB just to get storage.
6. Stale IndexedDB claims sat in comments and docs: `index.ts`,
   `boundary.ts`, `tauri-adapter.ts`, `table.test.ts`, `contract.ts`, the
   README, the evidence page source, and `canonical-callers.md`.

Found during the final reread and fixed:

7. `merge.test.ts` asserted that a dump lacked `inventory:kv.json`. That is
   an IndexedDB-era key the OPFS dump never produces, so the assertion always
   passed. It now checks `contents:kv.json`.
8. `browser.test.ts` named a test "survive reopening the database". It now
   says "the folder".

## Current and proposed tree

```txt
Current                                   Proposed (implemented)
packages/folder/src/                      packages/folder/src/
|-- browser-adapter.ts                    |-- browser-adapter.ts   + claimDirectory, markedAddress, occupant
|-- browser-migration.ts                  |
|-- browser-migration.test.ts             |-- browser-identity.test.ts   (new)
|-- browser-store.ts                      |
|-- legacy.test-support.ts                |
|-- browser-storage.test-support.ts       |-- browser-storage.test-support.ts   (createTestStorage)
`-- opfs.test-support.ts                  `-- opfs.test-support.ts   (opfsEnvironment(opfs, options?))
```

## What changed

### Identity under the open Web Lock

`claimDirectory(origin, directory, address)` in `browser-adapter.ts` runs
under `epicenter-folder-opfs-open:<address>`:

| The directory holds | Outcome |
| --- | --- |
| A marker whose `address` is this address | Opens. Extra properties are ignored by ordinary parsing and never rewritten. |
| Nothing, or no directory, or only an empty `.git` holding at most an empty marker | Writes `{"address": ...}`, then opens. |
| A marker naming another address | `Unavailable`, nothing written. |
| A marker that names no address (not UTF-8, not JSON, not an object, no string `address`) | `Unavailable`, nothing written, even with nothing beside it. |
| Any other entry without a marker, including a nonempty `.git` | `Unavailable`, nothing written. |
| A folder path that is a file, or under a file | `Unavailable`. |

A marker write that fails before its close, or whose close throws, makes the
open `Unavailable`, and no Git backend is created. The next open starts over
only where the marker is absent or empty. A close that published the marker
opens, and a close that published another address's marker stays refused.

Why an empty marker beside nothing is admitted: only opens of this address
write this directory's marker, because the directory name is an injective
function of the address. An empty marker carries no address, and an empty
directory holds no data, so admitting the directory adopts nothing. Refusing
it would brick a folder after one interrupted first open, with no recovery
path a person could reach.

### Removed

- `browser-migration.ts`, `browser-store.ts`, `legacy.test-support.ts`, and
  `browser-migration.test.ts`.
- `IndexedDbEnvironment` from the contract, and `OpfsEnvironment.indexedDb`.
- `OpenFolderError.NoIndexedDb`, `LegacyMigration`, `LegacyInUse`, and
  `LegacyScopeUnassigned`.
- The release-Local fence and the `scoped` legacy database naming.
- Eight legacy-only tests in `browser-scope.test.ts`.
- `fake-indexeddb` from `devDependencies`, and every use of it in Folder
  tests.

### Test fixture contract, pinned for app callers

```ts
export type TestStorage = {
  readonly opfs: MemoryOpfs;
  readonly BroadcastChannel?: typeof BroadcastChannel;
};
export function createTestStorage(options?: { BroadcastChannel?: typeof BroadcastChannel }): TestStorage;
export function browserStorage(storage: TestStorage): Pick<BrowserFolderOptions, 'opfs'>;
export function opfsOf(storage: TestStorage): MemoryOpfs;        // storage.opfs
export function testBrowserStorage(options?): Pick<BrowserFolderOptions, 'opfs'>;  // createTestStorage
export function dumpStorage(storage: TestStorage, id, skip?): Promise<Record<string, string>>;
export function rawBrowserFolder({ id, storage?: TestStorage }): Promise<RawBrowserFolder>;
// opfs.test-support.ts
export function opfsEnvironment(opfs: MemoryOpfs, options?: { BroadcastChannel?: typeof BroadcastChannel }): OpfsEnvironment;
```

`rawBrowserFolder` now writes the same `{"address": ...}` marker the opener
writes.

### Kept

Directory scopes stay separate: release Local, development, and each
authority/principal account have their own directory, open, files, and Git
locks, and hint channel, from an address captured before the first await.
File-write ordering, SHA-256 identity, Git objects and audio, and explicit
interrupted incoming recovery are unchanged. Every non-legacy test still
runs. The suites that used fake IndexedDB only as a storage key now use
`createTestStorage()` and still assert the same behavior. Where a test
asserted "no IndexedDB database was created", it now asserts "no OPFS
directory was created".

### New proof

`src/browser-identity.test.ts`, 13 tests:

- A fresh origin becomes the folder: its marker names the address, and the
  marker bytes are unchanged after a write, a commit, a close, and a reopen.
- A marker with extra `metadata` as an object or as `null` opens with its
  files, and its bytes are unchanged.
- Markers for another address are refused with every byte below the origin
  unchanged. The cases are development versus release, another ID, and an
  account.
- Markers that name no address are refused unchanged, even when nothing else
  is beside them. The cases are not JSON, `null`, `[]`, `{}`, a non-string
  address, and invalid UTF-8.
- Occupied unmarked directories are refused unchanged. The cases are a file,
  an empty subdirectory, `.git/HEAD`, an empty marker beside a file, `.git`
  as a file, and the marker path as a directory.
- A folder path that is a file, or under a file, is refused.
- An empty directory, or one holding only an empty marker, becomes the
  folder.
- When the marker write fails, the open is refused, no marker remains, and
  no Git state is started. The next open succeeds.
- When the failed write also leaves an empty file that cannot be removed,
  the open is refused as unknown, and the next open admits the directory.
- When a close throws, the open is refused. A `fail` close that published
  nothing leaves an empty marker, and the next open admits the directory. A
  `lost` close that published the marker means the next open finds the
  folder. A close that published another address's marker leaves the
  directory refused, and the marker is never overwritten.
- OPFS `getDirectory` rejecting is `Unavailable`, and nothing is created.
- The default global opener refuses with `NoFileSystem`, naming
  `navigator.storage.getDirectory`, `FileSystemFileHandle.createWritable`,
  or `navigator.locks` when that piece is missing.
- The default global opener opens, saves, closes, reopens, and reads with
  `indexedDB`/`IDBKeyRange` absent, and again with accessors that throw and
  count. The count stays 0. Globals are restored afterward, and the test
  asserts the restore.

`browser-scope.test.ts` adds this proof: development and account folders
start empty beside a populated Local folder of the same ID, and Local's
bytes are unchanged. The invalid-identity test also covers an unknown
channel.

`evidence/bundles/bundles.test.ts` now asserts that a build aliased to
`@epicenter/folder/browser` emits no `indexedDB` text anywhere.

Mutation checks, each reverted after the run: disabling the occupant refusal
failed "a directory holding anything without a marker is refused". Adding a
read of `globalThis.indexedDB` to `globalEnvironment` failed "the default
opener opens, saves, and reopens with IndexedDB absent or throwing".

### Evidence and docs

- README: the current contract is OPFS only. The IndexedDB requirement, the
  freeze and copy section, and the scoped fence paragraph are gone. A new
  "Which directory is the folder" section describes the marker table. The
  layout and commands sections describe the new fixtures. The limits section
  no longer mentions migration.
- `evidence/opfs/main.ts`: the migration check and the IndexedDB cleanup
  are removed. A real-browser identity check takes their place: an unmarked
  directory with a stray file, and a marker naming another address, are both
  refused, and both stay byte for byte. `serve.ts` docs no longer mention
  IndexedDB.
- `evidence/opfs/ACCEPTANCE.md` stays the dated record of its 2026-10-04
  run. A historical note now says that the migration check it lists was
  removed afterward, and that the page has not been rerun since.
- `evidence/edit-handle/canonical-callers.md`: "Today that is an IndexedDB
  database" now says "an OPFS directory".
- Left as historical, not production: `evidence/kv-merge-iteration/*`
  (dated iteration records that name `browser-store.ts` and IndexedDB
  transactions), and `evidence/browser-relationship.md` (a dated experiment;
  line 196 is a general origin-scoping statement). The untracked
  `prototypes/filesystem` and `prototypes/storage-layout` directories are
  generated storage-layout experiments. Their ZenFS/IndexedDB references
  (`prototypes/filesystem/zen.ts`, `NOTES.md`, and the built
  `storage-layout/out` assets) are historical and were not modified.
- Root ADR-0497 (`docs/adr/0497-browser-folders-use-scoped-opfs-directories.md`)
  at the delegated clone baseline describes the migration, `NoIndexedDb`, and the fence. It is outside
  this package and owned by the root, so it was not edited and needs an
  amendment there.

## Verification

Commands run from `packages/folder` in the sandbox:

| Command | Result |
| --- | --- |
| `bun test --isolate` (baseline, before edits) | 685 pass, 18 skip, 0 fail, 703 tests across 41 files |
| `bun test --isolate` (after) | 676 pass, 18 skip, 0 fail, 3813 expects, 694 tests across 41 files. 23 legacy tests were removed (15 migration, 8 scope fence) and 14 were added (13 identity, 1 scope): 685 − 23 + 14 = 676. |
| `bun test --isolate src/merge.test.ts` (after the final formatting edit) | 17 pass, 0 fail |
| `bun test --isolate evidence/bundles/bundles.test.ts` | 5 pass, 0 fail |
| `bun run typecheck` | Only the 4 baseline errors, identical before and after: `evidence/edit-handle/canonical-dev.ts` and `vite-config.ts` cannot resolve `@sveltejs/vite-plugin-svelte` and `vite-plugin-solid`. That evidence app's own dependencies are not installed in this clone. |
| `bun evidence/opfs/serve.ts --build` | Built. Vite printed only its usual chunk-size warning. |
| `bun x biome format` on touched files | Clean. `biome check` still reports pre-existing import order in `tauri.test.ts` (unsorted at HEAD) and in untouched files. |

Loopback Git HTTP tests ran in-process and passed in this sandbox.

## Delegated-run limits before coordinated integration

- The OPFS evidence page was compiled, not run: this sandbox has no browser.
  The new identity check has not been observed in a real browser.
  `ACCEPTANCE.md` says so.
- The desktop bridge suite (`EPICENTER_FOLDER_BRIDGE=1`) was not run. The
  desktop adapter changed only in a comment.
- Root `bun.lock` still lists `fake-indexeddb` under `@epicenter/folder`'s
  devDependencies. Root lock edits were outside this assignment, and the
  coordinator must refresh the lock. Other workspaces still declare
  `fake-indexeddb` themselves.
- App callers that break against this contract were not edited. The app
  agent owns them:
  - `apps/whispering/src/lib/workspace/types.ts:56` matches
    `refusal.name === 'NoIndexedDb'`.
  - `apps/whispering/src/lib/workspace/desktop.test.ts:286,296` expect
    `NoIndexedDb`. A server-like environment now gets `NoFileSystem` with
    `missing: 'navigator.storage.getDirectory'`.
  - `apps/todos/src/lib/incoming.test.ts` builds `{ indexedDB, IDBKeyRange }`
    for `browserStorage` and `opfsOf`. It should use `createTestStorage()`.
  - Other app imports call `testBrowserStorage()` with no arguments, which
    keeps its signature.
- A writer that ignores Web Locks could still add entries between the
  occupancy check and the marker write. Only cooperating opens are
  serialized.

## Coordinator acceptance follow-ups

Files read before the follow-up analysis:

```txt
.agents/skills/
|-- delegate-claude/SKILL.md
`-- post-implementation-review/SKILL.md
packages/folder/
|-- README.md
|-- package.json
|-- tsconfig.json
|-- src/
|   |-- browser-adapter.ts
|   |-- browser-migration.ts (retired source)
|   |-- browser-storage.test-support.ts
|   |-- browser-identity.test.ts
|   |-- browser-scope.test.ts
|   |-- entries.test.ts
|   |-- observers.test.ts (changed hunks)
|   |-- opfs-store.ts (affected contract)
|   |-- opfs.test-support.ts (affected helper)
|   |-- contract.ts (changed hunks)
|   `-- errors.ts (affected contract)
`-- evidence/
    |-- bundles/bundles.test.ts (changed hunks)
    |-- opfs/ACCEPTANCE.md
    `-- opfs-clean-break-review.md
```

The coordinator flagged these findings before making edits:

1. The address-parser comment and extra-property test still named a retired
   migration field. The current address-only record boundary needs a generic
   extra-property fixture. Both now describe that contract without a legacy
   compatibility promise.
2. The global-opener blocked-IndexedDB test proved bytes but lacked a Git
   persistence assertion. It now explicitly commits with automatic commits
   disabled, captures the one-entry log, and asserts the identical log after
   reopening while the getters still throw. No injected environment bypasses
   the production global opener.
3. The README said all refusals write nothing. That was broader than the
   marker-publication failure contract. It now states that identity refusals
   write nothing; the following paragraph explains first-write failures.

The worker reread every touched file after implementation. The coordinator
reviewed the runtime admission path, direct-tree helper, identity and account
regressions, caller deltas, and durable review, then reread the files changed
in these follow-ups. The parser owns unsafe JSON; the claim owns serialized
directory admission; the file boundary owns write ordering. Those boundaries
earn their place. No additional runtime layer or public API was added.

4. Independent review found a stale native-bundle exclusion assertion for
   `epicenter-folder-files:`. It could pass without excluding the current
   browser storage. The assertion now checks `epicenter-folder-opfs-files:`.
   Browser and native bundles also exclude both IndexedDB global names.
   This corrects test evidence, with no runtime change.

Coordinator native worker result: completed (`is_error: false`), session
`22745e51-60cb-4c6d-a426-1a8aaf350503`, model `claude-opus-5-5`. Three
Bash commands were denied; the worker used allowed tools or simpler commands
and completed its assignment. No unsandboxed retry or permission expansion
was used.

Coordinator verification after integration: the actual shared checkout's
`bun run typecheck` passes. The strengthened identity suite passes 13 tests
with 106 assertions, and bundle verification passes 5 tests with 46
assertions. Candidate full-suite verification reproduced 676 pass, 18 skip,
0 fail before those extra assertions; final live full-suite evidence follows
in the coordinated acceptance record. The clone's four missing-plugin
errors were reproduced before edits and did not occur in the live checkout.

5. The final coordinator review found an unnecessary cast in the identity
   test's global cleanup. `Reflect.deleteProperty(globalThis, name)` now
   removes temporary globals directly. The descriptor-absence assertions
   assume this isolated Bun runner has no IndexedDB preload; support for
   other test preloads is outside this regression's promise.

Final live verification: 676 pass, 18 skip, 0 fail, 3,821 assertions across
41 files; typecheck and OPFS evidence-page build pass. The additional cleanup
changes only the test helper; all 13 identity cases are rerun afterward.

## Staged artifact prerequisite review

Files read completely before the prerequisite analysis:

```txt
packages/folder/evidence/
|-- bundles/app/
|   |-- browser.ts
|   |-- main.ts
|   `-- tauri.ts
`-- shared-folder-workflow.ts
```

The fresh staged candidate initially passed all 18 identity and bundle tests
(152 assertions), but failed Folder typecheck in these four files. Its
committed callers still passed `id` to `defineFolder` and omitted the
required opener `id`; the shared workflow also imported retired
`DataDefinition`. The fixes were already present in the user's working
tree. They are explicit prerequisites, not worker-authored clean-break
changes. Root accepted their inclusion before staging.

The bundle fixtures now keep definitions identity-free and pass the dataset
ID to each browser/automatic/desktop opener. The directory demonstration
passes its physical root to the Bun opener and types its prepared schema as
`FolderDefinition`; it no longer invents a definition-owned dataset ID.
Inlining their `start` and `open` helpers preserves those ownership rules.
The bundle fixtures expose executable entries for build inspection; the
workflow's repeated opener centralizes its disposable directory and manual
history policy. Those boundaries earn their place. The reporting helpers
and raw-disk assertions remain local to the demonstration.

Current and proposed file organization are identical: the three bundle
entries remain separately buildable and the shared-folder workflow remains
one standalone experiment. No production edits, new abstractions, or
compatibility paths are needed. No new correctness concern was found in the
prerequisite diffs. The clean candidate installs the evidence page's own
committed dependencies using its frozen lockfile; it does not borrow live
node_modules or dirty source to resolve the two Vite plugins.

After the four accepted prerequisite files were included, the clean candidate
Folder typecheck passed. The shared-folder workflow ran in that candidate
with 87 assertions passed and 0 failed against a disposable disk directory,
then removed only that directory. The unchanged identity implementation
already passed all 13 cases there; all five bundle checks passed again
after the fixture changes. No full-suite rerun is needed for these evidence
callers.
