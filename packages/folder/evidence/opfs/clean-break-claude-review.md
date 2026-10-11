# Clean-break review: Folder speaks only OPFS

## Files read

Files I read in full or by range are listed below. Files marked `(grep)` were only searched.

```
/private/tmp/epicenter-clean-break-review-20261004
|-- clean-break-review-packet.md
|-- docs/adr/
|   |-- 0497-browser-folders-use-scoped-opfs-directories.md
|   `-- 0498-vocab-opens-one-local-folder-before-sign-in.md        (grep)
|-- .review-baseline/folder/
|   |-- evidence/opfs/main.ts                                       (grep)
|   `-- src/
|       |-- browser-adapter.ts
|       |-- browser-migration.ts
|       |-- browser-store.ts
|       |-- browser-storage.test-support.ts
|       |-- opfs-store.ts                                           (1..110, grep rest)
|       |-- index.ts, tauri-adapter.ts                              (grep)
|       `-- browser-migration.test.ts, legacy.test-support.ts,
|           browser-scope.test.ts, errors.ts                        (line counts / test names)
|-- packages/
|   |-- principal/src/account-key.ts
|   `-- folder/
|       |-- package.json, tsconfig.json
|       |-- README.md                                               (120..179)
|       |-- evidence/opfs/main.ts                                   (1..60, 760..999)
|       |-- evidence/bundles/bundles.test.ts                        (140..179)
|       `-- src/
|           |-- browser-adapter.ts
|           |-- opfs-store.ts
|           |-- contract.ts
|           |-- errors.ts
|           |-- browser-storage.test-support.ts
|           |-- browser-identity.test.ts
|           |-- browser-scope.test.ts
|           |-- git/opfs-incoming.test.ts                           (1..140)
|           |-- git/opfs-git.ts                                     (grep)
|           |-- opfs.test-support.ts, index.ts, tauri-adapter.ts    (grep)
`-- apps/
    |-- vocab/src/lib/folder.ts
    |-- vocab/src/lib/folder.test-support.ts
    |-- vocab/src/lib/legacy-*.ts                                   (grep: imports only)
    |-- whispering/src/lib/workspace/browser.ts
    |-- whispering/src/lib/workspace/browser.test.ts
    |-- whispering/src/lib/workspace/types.ts
    |-- whispering/src/lib/workspace/desktop.test.ts                (265..304)
    |-- whispering/src/lib/workspace.test-support.ts                (100..159)
    |-- todos/src/lib/platform-selection.test.ts
    |-- todos/src/lib/incoming.test.ts                              (20..159)
    |-- honeycrisp/src/lib/platform-selection.test.ts               (55..99)
    |-- honeycrisp/src/lib/platform/first-open.test.ts              (Bun opener; not relevant)
    `-- capture/src/lib/platform-selection.test.ts                  (45..89)
```

These helpers were read through as if inlined into their callers: `lookup`, `ensureDirectory`, `writePrivateFile`, `readHandle`, `holding`, `accountKey`, `entryName`, `folderAddress`, `markedAddress`, `occupant`, and baseline `prepareFolderDirectory` / `freeze` / `readLegacy` / `copy` / `localFence`.

## Verdict

I designed the browser opener from the outcome and the real callers before judging the snapshot. My design ended up matching the snapshot's design. **The design is worth adopting.**

What stops acceptance is four concrete breaks outside the opener itself:
- three app platform-selection tests,
- the Todos incoming test,
- the OPFS evidence page, which fails typecheck,
- the Whispering `NoIndexedDb` code, which another worker owns.

None of these needs a design change.

## Greenfield design from the outcome and callers

**What the callers need.** Vocab (`apps/vocab/src/lib/folder.ts:18-24`) and Whispering (`apps/whispering/src/lib/workspace/browser.ts:134-142`) both call `openFolder({ id, definition, browser: { author } })`. Neither passes `scope` or `opfs`, so production always opens release Local with the browser's own globals. Account and development scopes are exercised only by tests (ADR-0497 says "Unbuilt: application selection…"). Isolation still has to hold for future callers. The Todos, Honeycrisp and Capture browser leaves use the same call shape.

**The design:**
1. **Environment:** require `navigator.storage.getDirectory`, `FileSystemFileHandle.createWritable` and `navigator.locks`. `BroadcastChannel` is optional. Never probe IndexedDB. If something is missing, return `NoFileSystem`.
2. **Capture the address synchronously, before any await:** channel, owner (lowercase-hex `accountKey`, or `null` for Local) and ID. That one tuple produces the address string, the directory path, the three lock names and the hint-channel name. The escaping in `entryName` keeps distinct values distinct. Account keys are 64 lowercase hex characters (`account-key.ts:3-6`), so account directories cannot collide.
3. **Identity:** the path is the primary identity. The marker `.git/epicenter-folder.json` is a check on that identity:
   - It is written once, under the open lock, before any content exists.
   - It is checked on every open.
   - Extra properties (the baseline wrote `migratedFrom`) are accepted.
   - A mismatched or malformed marker is refused.
   - An unmarked directory is adopted only if it is structurally empty, meaning an empty `.git` holding at most an empty marker. That empty-marker case is what an interrupted first open leaves.
4. **Git:** use the same root. An incoming-update record left by a closed tab stays pending until someone explicitly asks to recover it.
5. **IndexedDB:** none anywhere : no reads, no freezing, no deletion.

**What the snapshot does** (`browser-adapter.ts:59-83, 103-121, 126-213, 288-366`):
- It is exactly this design.
- The address, directory, lock names and hint name are byte-identical to the baseline (compare baseline `browser-adapter.ts:103-121, 197-200`).
- `opfs-store.ts` differs from the baseline only by removing the `indexedDb` field and its import, plus a doc line.
- `storage.ts`, `git/opfs-git.ts`, `git/browser-backend.ts` and `git/history.ts` are unmodified (they are absent from the M list).

## What it must preserve to be worth adopting

| Guarantee | Mechanism | Status in snapshot |
|---|---|---|
| Current OPFS directory identity | `folderAddress` unchanged; a marker with extra fields is accepted (`browser-adapter.ts:126-144`); a baseline-written `{address, migratedFrom}` opens and is never rewritten (`browser-identity.test.ts:85-103`) | Kept |
| Captured account and channel isolation | Scope is read synchronously; `accountKey` reads its fields before its first await; three locks and one hint channel per address (`browser-scope.test.ts:90-159`) | Kept. The Local fence was dropped, correctly (see below) |
| One-file ordered publication | Files Web Lock plus `pageOrder` keyed by files lock (`opfs-store.ts:689-835`), `withPublication` | Unchanged code |
| Stable audio | Plain files read through `folder.files.read` (Whispering `browser.ts:162-176`) | Unchanged code |
| Explicit Git incoming recovery | `epicenter-incoming.json` and pins under `.git`. The claim returns on a valid marker without touching `.git` (`browser-adapter.ts:193-199`). The reopen test goes through the production opener (`opfs-incoming.test.ts:77-112`) | Kept |
| No Folder IndexedDB | `globalEnvironment` has no IndexedDB check; `OpfsEnvironment` has no `indexedDb` field; `fake-indexeddb` is out of the folder's `package.json` | Kept inside the package; app leftovers listed below |

## Current OPFS safety vs inherited migration promises

Traced through the baseline `prepareFolderDirectory` (`browser-migration.ts:454-534`) and the new `claimDirectory`.

**Inherited migration promises, now dropped (dropping them is correct):**
- **Freeze at `FROZEN_VERSION`** (`browser-migration.ts:83-122`). This existed only to stop older builds writing to the IndexedDB database being copied.
- **Copy cursor, ownership of empty files, and the "directory exactly equals the database" check** (`:249-359`).
- **Local fence for scoped folders, `LegacyScopeUnassigned`** (`:411-444`). It stopped a sign-in from starting a scoped folder beside unclaimed Local IndexedDB data. With no IndexedDB, nothing is left to fence. ADR-0497 states that a new account folder does not inspect Local.
- **`LegacyInUse`, `LegacyMigration`, `NoIndexedDb`.**

**Current OPFS safety, kept:**
- An existing marker with the matching address opens.
- A mismatched or unreadable marker is refused.
- All of it happens under `epicenter-folder-opfs-open:<address>`. That is the same lock name the baseline used, so a cached baseline tab and a new tab still take turns on the first open.
- When a baseline build meets a new-build marker `{address}`, its `readMarker` sees "ready" and opens it without freezing anything.

**Kept, but inherited in origin:** refusing a non-empty directory that has no marker (`occupant`, `:150-163`).
- New code always writes the marker before any content, so it never produces this state.
- The only sources are an interrupted baseline copy (the baseline wrote the marker last), a foreign writer in the same origin, or a future bug.
- I recommend keeping it. It is about 14 lines and enforces "never adopt bytes this address did not create".
- It has a cost, described under the alternatives below.

**Lifecycle sequences checked:**
- **Fresh origin:** directory and marker are created, then Git initialises lazily. A crash after the marker but before `HEAD` reopens fine; the "creation stopped before HEAD" case is covered in `opfs-incoming.test.ts`.
- **Marker write fails and its removal succeeds:** `.git` is left empty, and the next open adopts the directory.
- **Marker write fails and its removal also fails:** an empty marker is left. The open is refused as "unknown", and the next open adopts.
- **Marker close throws but the bytes were published:** the open is refused, and the next open finds the marker and opens.
- **A different marker is published concurrently:** it is refused permanently and never overwritten.
- **Reopen with a pending incoming record:** the marker is valid, the claim returns, and the record remains pending until explicit recovery.

All of these are covered in `browser-identity.test.ts:178-263`.

## Alternatives and where each breaks

| Alternative | What it buys | What it breaks or who pays |
|---|---|---|
| **No marker: the path is the identity** (deletes about 90 lines and the identity suite) | Simplest; no identity refusals | Directory identity is no longer *checked*. A future change to `entryName` or `folderAddress` would silently open another address's bytes, including another account's if the owner segment changes. Interrupted baseline copies would be adopted with a partial `.git`: baseline copied Git keys in sorted order (`HEAD`, `config`, `index`, `objects/…`, `refs/…`), so an interruption can leave `HEAD` and the index without objects or refs. The user then sees partial data and broken history with no explanation. |
| **Keep the marker but adopt unmarked non-empty directories** | No permanent lock-out | Same partial-copy adoption as above. |
| **Quarantine or delete unknown contents** | Self-healing | Mutates or deletes user bytes automatically, against the spirit of "no automatic deletion" and "no recovery tool". OPFS has no portable directory rename. |
| **New root, e.g. `Epicenter/v2/…`** | Sidesteps all leftovers | Breaks "preserve current OPFS directory identity". Users whose folders the baseline already migrated lose them. |
| **Probe IndexedDB only to show an "old data exists" notice** | Users learn why their data vanished | Violates "no Folder IndexedDB at all". Reintroduces the dependency and its blocked or throwing failure modes. |
| **Snapshot design (recommended)** | Identity checked; fresh, interrupted and pending states handled | Users with an interrupted baseline copy get a permanent `Unavailable` with no in-app fix. Their only way out is clearing site data, which also wipes Whispering's `localStorage` connections and keys. How many such users exist depends on whether the baseline build ever reached users (see missing evidence). |

## Deletion prize

- **Deleted:**
  - `browser-migration.ts` (535 lines)
  - `browser-store.ts` (49)
  - `browser-migration.test.ts` (570)
  - `legacy.test-support.ts` (95)
  - four `OpenFolderError` variants (`errors.ts` 393→364)
  - the `indexedDb` field from the public `OpfsEnvironment`
  - IndexedDB scoped/legacy database naming (baseline adapter `:195-222`)
  - `fake-indexeddb` from the folder's dev dependencies
- **Trimmed:** `browser-scope.test.ts` from 437 to 231 lines; seven IndexedDB-fence tests removed.
- **Net:** about −1,030 lines. There is also no IndexedDB in the open path at all, so the open works where IndexedDB is blocked or throws (`browser-identity.test.ts:339-377`).

## Introduced complexity

- `claimDirectory`, `occupant` and `markedAddress`: about 90 lines in `browser-adapter.ts` (317→393).
- `browser-identity.test.ts`: 378 lines, new.
- The test identity changed from "one `IDBFactory` maps to one tree through a WeakMap" (baseline `browser-storage.test-support.ts:41-61`) to "one `MemoryOpfs`" (`:34-60`). That is simpler and direct.
- The new refusal modes all surface as `Unavailable` with free-text causes.

## Current and proposed tree

```
packages/folder/src                      (current snapshot = proposed; no structural change)
|-- browser.ts            public entry (unchanged)
|-- index.ts              automatic entry, lazy browser-adapter (doc-only change)
|-- contract.ts           BrowserFolderOptions.opfs?: OpfsEnvironment (test injection)
|-- browser-adapter.ts    globalEnvironment · entryName · folderAddress ·
|                         markedAddress · occupant · claimDirectory · openFolder · openOpfsFolder
|-- opfs-store.ts         OpfsEnvironment{getDirectory, locks, BroadcastChannel?} ·
|                         PRIVATE_DIRECTORY · READY_MARKER · boundary · pageOrder
|-- storage.ts            withPublication (unchanged)
|-- git/{opfs-git,browser-backend,history}.ts   (unchanged)
|-- errors.ts             OpenFolderError without NoIndexedDb/Legacy*
|-- browser-storage.test-support.ts  TestStorage{opfs, BroadcastChannel?}
|-- browser-identity.test.ts         new
|-- browser-scope.test.ts            trimmed
`-- ✗ browser-migration.ts · browser-store.ts · browser-migration.test.ts · legacy.test-support.ts
```

The only possible change to the proposed tree is the optional typed refusal described under speculative improvements.

## Concrete blockers (grounded)

1. **Three app platform-selection tests require the deleted `browser-store.ts`.**
   - Files: `apps/todos/src/lib/platform-selection.test.ts:84`, `apps/honeycrisp/src/lib/platform-selection.test.ts:89-91`, `apps/capture/src/lib/platform-selection.test.ts:71-76`.
   - Each asserts that the browser module graph *contains* `13f7c93559:packages/folder/src/browser-store.ts`. At baseline it was pulled in at runtime through `browser-migration.ts`; now it is gone, so these assertions fail.
   - Fix: require `opfs-store.ts` (and `git/opfs-git.ts`) instead. Mentions of `browser-store` in the "forbidden" regexes are harmless but stale. Rename the tests titled "IndexedDB adapter".

2. **The Todos incoming test still builds fake-IndexedDB test storage.**
   - File: `apps/todos/src/lib/incoming.test.ts:31,116,127,138`.
   - It builds `{ indexedDB: new IDBFactory(), IDBKeyRange }` and passes it to `browserStorage` and `opfsOf`. `TestStorage` is now `{ opfs: MemoryOpfs }` (`browser-storage.test-support.ts:34-37,58-73`).
   - Typecheck fails. At runtime, `storage.opfs.getDirectory()` throws a TypeError, which becomes `Unavailable`, so every `openDemo` fails.
   - Fix: `const storage = createTestStorage()` and drop the `fake-indexeddb` import.

3. **The OPFS evidence page fails package typecheck.**
   - File: `packages/folder/evidence/opfs/main.ts:768-842, 991`.
   - `migration()` and `rawContents()` still use `seedLegacyFolder`, `legacyName` and `LegacyContents`. Their import (baseline `:43-46`) and definition (baseline `:237-238`) were removed. `main()` still calls `migration(runId)`.
   - `tsconfig.json:8` includes `evidence/**/*.ts`, so `tsc --noEmit` fails.
   - The header (`:26-28`) describes an identity check that does not exist.
   - Fix: delete the migration scenario and add the identity check the header describes, or remove that claim. This is probably the fixture conversion that is still in progress, but it blocks "typecheck passed".

4. **Whispering still uses `NoIndexedDb` (owned by the separate worker; listed as an acceptance condition, not a fault of this snapshot).**
   - `apps/whispering/src/lib/workspace/types.ts:56` compares against `'NoIndexedDb'`. That literal is no longer in the union, so TS2367 fires.
   - `desktop.test.ts:286,296` expect `NoIndexedDb`. Under Bun the opener now returns `NoFileSystem` (missing `navigator.storage.getDirectory`).
   - `desktop.test.ts:297`'s `toContain('cannot be opened')` will also fail, because the `NoFileSystem` message does not contain that phrase.

## Speculative improvements (not required by the outcome)

- **Typed identity refusal.** "Directory is not this folder's" and "storage unreachable or denied" are both `Unavailable` (`errors.ts:316-324`). Apps cannot tell a permanent refusal from a transient one, or show "clear site data" guidance. A `NotThisFolder({ directory, found })` variant would fix this, at the cost of one more error variant and Whispering mapping it.
- **Stale documentation:**
  - Whispering `browser.ts:9-12` still says IndexedDB is needed to check earlier files.
  - `apps/whispering/ARCHITECTURE.md:122` says earlier IndexedDB folders are "copied there once".
  - The Todos platform-selection header and test titles mention IndexedDB.
- **Bundle checks.** In `bundles.test.ts:164`, the negative check for `'epicenter-folder-files:'` names a retired lock name, so it is vacuous; the current name is `epicenter-folder-opfs-files:`. There is also no browser-bundle check for the absence of `indexedDB`.
- **Brittle global assertion.** `browser-identity.test.ts:375-376` asserts there is no global `indexedDB` descriptor. That is safe under `--isolate` but would break if a preload installed `fake-indexeddb/auto`.
- **Possible permanent refusal from marker loss.** If a browser ever persisted later files but lost the earlier marker after a power loss, `occupant` would turn that into a permanent refusal. ADR-0497 makes no power-loss promise. Chromium's sequential metadata log makes this ordering unlikely. Revisit only if evidence appears; do not add heuristics now.

## Missing evidence

- **Did the 13f7c93559-era build, which copied IndexedDB into OPFS, ever reach users?** ADR-0497 is dated 2026-10-03 and amended 2026-10-04. If it never shipped, the "interrupted baseline copy causes a permanent refusal" population is empty and the trade-off is moot. If it shipped, the size of that population decides whether the typed refusal is worth adding.
- **The real-browser runs ADR-0497 requires** (fresh open, reopen, scoped isolation, IndexedDB unavailable) have not been recorded. Blocker 3 currently stops that evidence page from compiling.
- **Final checks are still pending**, per the packet.

## Discriminating checks

1. **Baseline-migrated folder with a pending update:** a directory holding `{address, migratedFrom:{database, version:1}}`, files, `.git` history and a pending `epicenter-incoming.json` opens. The log is intact, the record stays pending, commits wait, and explicit recovery completes. This combines the existing identity and incoming fixtures to prove that state survives the cutover.
2. **Interrupted baseline copy:** files and a partial `.git` (`HEAD`, `index`, some objects), no marker. The result is `Unavailable` and the whole tree is byte-identical afterwards.
3. **Golden identity strings:** for a fixed set of addresses (release/development × Local/two accounts × a tricky ID with `%`, `/`, `.`), assert the directory, three lock names and hint name equal the baseline's strings. This locks "preserve current OPFS directory identity" against refactors.
4. **Mixed versions:** the baseline adapter (from `.review-baseline`) and the new adapter use the same `MemoryOpfs` and locks. New creates and baseline then opens with no freeze. Racing first opens are serialised by the shared open lock.
5. **Bundle:** the browser-alias bundle contains no `indexedDB` or `IDBKeyRange`. First confirm the dependencies emit neither.
6. **Grep gate:** no `indexedDB|IDBKeyRange|fake-indexeddb|browser-store|NoIndexedDb|Legacy(Migration|InUse|ScopeUnassigned)` in `packages/folder/{src,evidence}` or in the apps' folder tests and test-support. Yjs, blob and SQLite packages are excluded.
7. **Whispering after the worker's change:** `openBrowserWorkspace()` under Bun returns `BrowserFolder` with refusal `NoFileSystem`, and the message assertion is updated.
8. **Full suites:**
   - folder `bun test --isolate` and `tsc --noEmit` (evidence included),
   - Todos `incoming.test.ts` and the three platform-selection tests,
   - Vocab and Whispering workspace tests,
   - the real-browser `evidence/opfs` page, with results recorded separately from the stand-in runs.
