# Independent clean-break review

## Files read

All paths below are relative to `/tmp/epicenter-clean-break-review-20261004`. The inventory includes focused excerpts, diffs, and search matches; it does not imply that every large file was read end to end. No reviewed source was edited. The packet exposed the implementation and its rationale, so this was an independent review, not a blind review.

```text
.
|-- AGENTS.md
|-- clean-break-review-packet.md
|-- .agents/skills/
|   |-- adversarial-review/
|   |   |-- SKILL.md
|   |   `-- references/example-workflow.md
|   |-- post-implementation-review/SKILL.md
|   `-- rethink/
|       |-- SKILL.md
|       `-- references/
|           |-- clean-breaks.md
|           |-- greenfield.md
|           `-- radical-options.md
|-- .review-baseline/folder/src/
|   |-- browser-adapter.ts
|   |-- browser-migration.ts
|   |-- browser-store.ts
|   `-- opfs-store.ts
|-- apps/
|   |-- README.md
|   |-- vocab/
|   |   |-- README.md
|   |   `-- src/
|   |       |-- lib/
|   |       |   |-- boot-node.test.ts                  (search matches)
|   |       |   |-- folder.ts
|   |       |   |-- legacy-import.ts                  (search matches)
|   |       |   |-- legacy-import.test.ts             (search matches)
|   |       |   `-- legacy-source.ts                  (search matches)
|   |       `-- routes/
|   |           |-- +page.svelte                      (search matches)
|   |           `-- components/
|   |               |-- LegacyImport.svelte           (search matches)
|   |               `-- VocabShell.svelte             (search matches)
|   `-- whispering/
|       |-- AGENTS.md
|       |-- README.md
|       `-- src/
|           |-- lib/
|           |   |-- audio-source.ts
|           |   |-- connections.ts                    (search matches)
|           |   |-- definition.ts                     (search matches)
|           |   |-- home-controls.test.ts             (search matches)
|           |   |-- library.svelte.ts
|           |   |-- library.test.ts                   (search matches)
|           |   |-- settings-draft.svelte.ts          (search matches)
|           |   |-- workspace.test-support.ts         (search matches)
|           |   `-- workspace/
|           |       |-- browser.ts
|           |       |-- browser.test.ts               (search matches)
|           |       |-- desktop.ts                    (search matches)
|           |       |-- desktop.test.ts               (search matches)
|           |       `-- types.ts
|           `-- routes/components/
|               |-- AudioPlayer.svelte
|               `-- SettingsForm.svelte              (search matches)
`-- packages/
    |-- principal/src/account-key.ts
    `-- folder/
        |-- README.md
        |-- package.json
        |-- evidence/
        |   |-- bundles/bundles.test.ts
        |   |-- kv-merge-iteration/
        |   |   |-- integrated-source-fingerprint.json (search matches)
        |   |   `-- review.md                          (search matches)
        |   `-- opfs/main.ts
        `-- src/
            |-- boundary.ts
            |-- browser.ts
            |-- browser-adapter.ts
            |-- browser-identity.test.ts
            |-- browser-opfs.test.ts
            |-- browser-scope.test.ts
            |-- browser-storage.test-support.ts
            |-- browser.test.ts
            |-- close.test.ts                         (search matches)
            |-- contract.ts
            |-- definition.ts
            |-- definition.test.ts                    (search matches)
            |-- errors.ts
            |-- files.test.ts                         (search matches)
            |-- folder.ts
            |-- index.ts
            |-- kv.test.ts                            (search matches)
            |-- merge.test.ts                         (search matches)
            |-- native.test.ts                        (search matches)
            |-- opfs-store.ts
            |-- opfs.test-support.ts
            |-- storage.ts
            |-- table.test.ts                         (search matches)
            |-- tauri-adapter.ts
            `-- git/
                |-- browser-backend.ts
                |-- history.ts
                |-- history-attempt.test.ts            (search matches)
                |-- history-ordering.test.ts           (search matches)
                |-- history.test.ts                    (search matches)
                |-- opfs-git.ts
                `-- opfs-incoming.test.ts
```

## Recommendation

Keep the new organizing idea: an opened Folder is a lifetime over one captured-address OPFS directory, with typed interpretations of its files and Git beside those files. Finish deleting the IndexedDB acquisition, migration, and Vocab import families. Retain the directory marker, publication ordering, stable byte reads, and explicit Git incoming recovery. The snapshot's production opener realizes this destination without introducing a replacement migration abstraction.

The decisive claim is that the removed machinery enforced a promise the user has explicitly refused: recovering and freezing earlier IndexedDB data. The retained machinery enforces promises the user still requires. Removing both together would erase the distinction between an abandoned storage format and the current folder's identity and publication semantics.

## Strongest greenfield design

The concrete callers want this:

```ts
const opened = await openFolder({
  id: VOCAB_FOLDER_ID,
  definition: vocabFolder,
  browser: { author: { name: 'Vocab', email: 'vocab@localhost' } },
});
// Use the returned files/tables/history; close the same handle on departure.
```

Whispering makes the same opening with its own stable ID, then owns that handle in its workspace. Its workspace exposes file capabilities and closes the folder. Neither caller needs an earlier database handle, a migration decision, a compatibility mode, or a recovery import workflow. The account option remains a captured input to opening, rather than a reactive login subscription. Vocab's actual opener continues to choose release Local independently of sign-in.

I would build the following ownership model from those uses:

```text
app mounted lifetime
`-- opened Folder
    |-- captured address: channel + owner + dataset ID
    |   `-- deterministic existing OPFS path, lock names, hint channel
    |-- claimed directory
    |   |-- public files: sole saved-data authority
    |   `-- .git/
    |       |-- address marker: durable identity
    |       |-- objects/index/refs: history
    |       `-- incoming record: admitted publication needing explicit recovery
    |-- typed table/KV views and ordinary file methods
    `-- close fence and owned Git/network lifetime
```

The opener validates and captures the address before awaiting storage. Under the address's open lock, it either opens a directory whose marker names that address, claims an empty first-open footprint, or refuses without adopting unknown contents. It then assembles the handle. Ordinary content writes use the files lock and page submission ordering. Git owns its separate queue, durable incoming record, and recovery request. One-file methods stay one-file methods; there is no transaction promise between Whispering's audio creation and row creation.

The marker's other stored properties are irrelevant to the address contract. Keeping an existing marker byte for byte while reading its address is preservation of an existing OPFS directory, not maintaining an IndexedDB reader or alternate data model. Requiring a new marker format or rewriting `migratedFrom` away would introduce a needless on-disk migration.

## Current and proposed trees

Task-start shape, restricted to this decision:

```text
packages/folder/src/
|-- browser-adapter.ts
|-- browser-migration.ts        freeze/read/copy/cursor/local fence
|-- browser-migration.test.ts
|-- browser-store.ts            earlier database format
|-- legacy.test-support.ts
|-- browser-storage.test-support.ts  fake IDB identity -> OPFS tree
|-- opfs-store.ts
`-- git/{browser-backend,opfs-git,history}.ts
apps/vocab/src/
|-- lib/{legacy-source,legacy-import,legacy-import.test}.ts
`-- routes/components/LegacyImport.svelte
```

Strongest compliant destination:

```text
packages/folder/src/
|-- browser-adapter.ts          capture/claim/open; marker parse stays local
|-- browser-identity.test.ts
|-- browser-storage.test-support.ts  explicit MemoryOpfs ownership
|-- opfs.test-support.ts
|-- opfs-store.ts               files and ordered publication
`-- git/{browser-backend,opfs-git,history}.ts
apps/vocab/src/
|-- lib/folder.ts               same stable Local dataset opening
`-- routes/components/VocabShell.svelte  no earlier-data import panel
apps/whispering/src/lib/workspace/
|-- browser.ts                  OPFS capability/refusal wording
`-- types.ts                    no NoIndexedDb branch
```

The frozen package already has the proposed production tree. The consumer removals are identified in the packet as a separate worker's pending integration. No additional file split is warranted for the new directory claim.

## Deletion prize and replacement guarantees

The baseline migration has real complexity: database version fencing, blocked connections, metadata/content reconciliation, hashed copy verification, cursor-owned interrupted creation, exact target comparison, a ready marker with migration provenance, and a Local database fence before starting another scope. The accepted clean break deletes all of those operations, their errors and environment types, their tests, and their fixtures. The fake-IDB-factory-to-OPFS WeakMap disappears because TestStorage directly owns MemoryOpfs. Vocab's earlier store declarations, account assignment, import dependency checks, repeated-import policy, and UI disappear with the refused import promise.

The replacement guarantee is simpler and narrower: opening depends only on this address's current OPFS directory. A scoped folder never consults Local or an earlier database. An unknown directory is refused; it is neither copied nor assigned. Earlier IndexedDB-only data stays outside the current product. The accepted consequence is that such data does not appear. There is no user recovery obligation hidden behind this recommendation.

The introduced complexity is the small first-open claim state machine: missing, empty interrupted footprint, marked for this address, or refused. It has one address parse boundary and one directory-content inspection. These replace a substantially larger cross-storage protocol. The state machine still needs tests for write failure, uncertain stream close, wrong marker, malformed bytes, and nonempty unmarked contents; `browser-identity.test.ts` covers these cases in the stand-in.

## Serious alternative tested

The strongest further deletion would make the deterministic directory path sufficient identity and let raw directory/file handles be the public API. That could delete marker parsing, occupant checks, part of the opener, and the storage wrappers.

It loses on the required guarantees. The current path spelling cannot establish that contents placed there belong to the captured address. A copied account directory or an unmarked interrupted directory would be silently adopted and Git initialization could start writing into it. Raw handles also make every consumer own hashing, conditional publication, close-result classification, and byte-copying for playback. A path-backed File snapshot can stop reading after replacement; the current OPFS boundary and Whispering's `loadAudio` deliberately construct a Blob from acquired bytes. `loadAudio` also keeps the same object when the hash is unchanged, so a refresh does not restart playback. Moving those responsibilities into apps shrinks Folder by multiplying policies and failures at callers.

Removing explicit incoming recovery offers another large deletion, but directly conflicts with the required behavior. Ordinary saves can continue while an incoming update is pending, so implicit replay can overwrite a later edit. The durable record's before/after/third-state assessment owns that distinction. A no-recovery proposal would have to forbid those saves, discard partial changes, or make the person reset the folder; all change accepted guarantees. Retain the current Git record and explicit `recoverIncoming()`.

## Mental inlining and invariant owners

| Boundary | Verdict after inlining |
| --- | --- |
| `entryName` and `folderAddress` | Keep. One canonical derivation owns directory identity and consistent lock/hint names. `%`, separators, and dot names require escaping to avoid aliases. |
| `markedAddress` | Keep local. One caller is justified by parsing unsafe durable bytes with fatal UTF-8 decoding; no exported marker type or generic codec is needed. |
| `occupant` | Keep local. Its name explains the bounded first-open-footprint inspection and lets the claim read as a decision. Inlining saves no policy. |
| `claimDirectory` | Keep local. Owns the storage acquisition invariant under the open lock; separating another module adds a hop without another consumer. |
| `openOpfsFolder` | Keep. One caller, but a long acquisition/assembly phase and release-on-failure lifetime justify it. Its generic carries the public caller's interpretation through assembly. |
| `createOpfsFileBoundary` | Keep. Shared by ordinary publication and raw test construction; owns portable paths, condition checks, one-file publication, stable open bytes, files locking, and page order. |
| `withPublication` and `fenceStorage` | Keep. Accounting and the close fence apply across acquired backends. Inlining them into tables/files/KV creates competing owners. |
| `createStoredGitBackend` / `createOpfsGitStore` | Keep for this break. Git algorithm/session behavior and OPFS publication/recovery have separate concrete invariants. A single production OPFS store does not make the external filesystem boundary worthless. Folding the two now broadens the change without deleting a refused product promise. |
| `createFileHints` and the relay | Keep. Local observation is distinct from cross-tab hints; relay failure must never become save failure. |
| `opfsOf` test helper | Optional future deletion. It now returns `storage.opfs`, so it is a forwarding accessor. It has many real test callers and introduces no runtime policy; replacing them is cosmetic, not a correctness or design acceptance requirement. |

The open lock protects identity claiming. The files lock protects conditions and publication. Page order persists across handles because the sequence and reached-path map are page-owned. The Git lock and incoming record protect history publication. The mounted workspace owns the opened folder's runtime lifetime. These owners remain intact across the production diff.

## Correctness blockers

No grounded new production correctness blocker was found in the directory claim, address derivation, or public API removal inspected here. This is not final acceptance and does not assert that pending checks passed.

The frozen runnable browser evidence is unfinished: `evidence/opfs/main.ts:768` still defines an IndexedDB migration check, `:785` calls `seedLegacyFolder`, `:819` names `LegacyContents`, and `:991` invokes that check. Its imports no longer provide those deleted names. That snapshot cannot establish the new real-browser acceptance result. This is pending fixture conversion, not a finding that the final implementation must retain migration. The coordinator reports that this worker has since removed that evidence path; final verification must use the integrated artifact.

Whispering's `workspace/types.ts:56` still compares the removed `NoIndexedDb` error name, and the frozen Vocab README and UI still describe/import earlier stores. Those are the explicitly known pending consumer retirement paths. They must disappear in the final sweep; they are not evidence against the chosen production design. Whispering's unrelated local-storage connection-key adoption is outside this Folder persistence break.

## Verification and final discriminating check

I inspected the cumulative production diff, source, actual opening callers, marker tests, scope tests, OPFS publication tests, Git recovery code/test sequences, and bundle tests. The frozen clone has no installed node_modules, and I did not install dependencies or run tests in it. The supplied task-start baseline is 685 pass, 18 skip, 0 fail with typecheck passing. Final snapshot verification is pending, so failures have not been attributed to an implementation wave.

The final discriminating check should open the same current OPFS folder before and after the change, with existing file bytes, history, and marker bytes preserved; open Local, development, and two account addresses separately; and reopen an interrupted incoming update without writing or clearing it until explicit recovery. Run that in the real browser with IndexedDB unavailable or a throwing getter, then create/play audio, replace its path, and verify the already acquired Blob remains readable. In the stand-in suite, retain the held-digest save-order race and uncertain-close cases. These distinguish an OPFS-only opener preserving the required guarantees from a smaller implementation that has merely displaced them.

Finally, the integrated Folder/consumer typechecks, tests, emitted-browser-bundle check, and scoped static-reference sweep must pass. Retire migration-specific checks and docs rather than rebuilding them under another name. No further architecture change is required to reach the accepted destination.
