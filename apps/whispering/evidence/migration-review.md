# App migration cumulative review

## Files read before analysis

```text
|-- .agents
|   `-- skills
|       |-- consult-claude
|       |   `-- SKILL.md
|       |-- delegate-claude
|       |   `-- SKILL.md
|       |-- post-implementation-review
|       |   `-- SKILL.md
|       `-- standalone-commits
|           |-- SKILL.md
|           `-- references
|               `-- splitting-into-ordered-waves.md
|-- apps
|   |-- vocab
|   |   |-- README.md
|   |   |-- evidence
|   |   |   |-- local-folder-journey.jpg
|   |   |   |-- local-folder-journey.md
|   |   |   |-- opfs-migration.md
|   |   |   |-- opfs-migration.png (browser agent observed)
|   |   |   `-- reading-and-capture.md
|   |   |-- package.json
|   |   |-- scripts
|   |   |   `-- loop-repro.ts
|   |   |-- src
|   |   |   |-- lib
|   |   |   |   |-- boot-node.test.ts
|   |   |   |   |-- chat
|   |   |   |   |   |-- chats.svelte.ts
|   |   |   |   |   |-- messages.test.ts
|   |   |   |   |   |-- messages.ts
|   |   |   |   |   |-- opening.test.ts
|   |   |   |   |   |-- session.svelte.ts
|   |   |   |   |   `-- session.test.ts
|   |   |   |   |-- data.test.ts
|   |   |   |   |-- data.ts
|   |   |   |   |-- entries.svelte.ts
|   |   |   |   |-- entries.test.ts
|   |   |   |   |-- folder.test-support.ts
|   |   |   |   |-- folder.ts
|   |   |   |   |-- inference.test.ts
|   |   |   |   |-- inference.ts
|   |   |   |   |-- legacy-import.test.ts
|   |   |   |   |-- legacy-import.ts
|   |   |   |   |-- legacy-source.ts
|   |   |   |   |-- reread.test.ts
|   |   |   |   |-- reread.ts
|   |   |   |   |-- resources.ts
|   |   |   |   |-- svelte-modules.test-support.ts
|   |   |   |   |-- word.svelte.ts
|   |   |   |   `-- word.test.ts
|   |   |   `-- routes
|   |   |       |-- +layout.svelte
|   |   |       |-- +page.svelte
|   |   |       `-- components
|   |   |           |-- AccountMenu.svelte
|   |   |           |-- ConversationView.svelte
|   |   |           |-- EntryCard.svelte
|   |   |           |-- FocusWords.svelte
|   |   |           |-- LegacyImport.svelte
|   |   |           |-- PhraseCapture.svelte
|   |   |           |-- VocabShell.svelte
|   |   |           `-- WordsView.svelte
|   |   `-- vite.config.ts
|   `-- whispering
|       |-- AGENTS.md
|       |-- README.md
|       |-- docs
|       |   |-- desktop-verification.md
|       |   |-- folder-bootstrap-iteration.md
|       |   `-- recipe-playground.md
|       |-- evidence
|       |   |-- opfs-migration.md
|       |   `-- opfs-migration.png (browser agent observed)
|       |-- native
|       |   |-- device-file.ts
|       |   |-- device-preferences.test.ts
|       |   |-- failure-injection.test.ts
|       |   |-- failure-injection.ts
|       |   |-- host.test.ts
|       |   `-- host.ts
|       |-- package.json
|       `-- src
|           |-- lib
|           |   |-- connections.ts
|           |   |-- definition.test.ts
|           |   |-- definition.ts
|           |   |-- deletion-copy.ts
|           |   |-- editor.svelte.ts
|           |   |-- editor.test.ts
|           |   |-- formats.test.ts
|           |   |-- home-controls.test.ts
|           |   |-- leave.test.ts
|           |   |-- library.svelte.ts
|           |   |-- library.test.ts
|           |   |-- microphone-input.test.ts
|           |   |-- post-processing.ts
|           |   |-- recipe-playground.test.ts
|           |   |-- recipe.ts
|           |   |-- recording-collection.test.ts
|           |   |-- recording-collection.ts
|           |   |-- recordings
|           |   |   |-- publish.test.ts
|           |   |   `-- publish.ts
|           |   |-- row-draft.svelte.ts
|           |   |-- row-draft.test.ts
|           |   |-- row-slot.test-support.ts
|           |   |-- session.svelte.ts
|           |   |-- session.test.ts
|           |   |-- settings-draft.svelte.ts
|           |   |-- status.test.ts
|           |   |-- status.ts
|           |   |-- transcription.ts
|           |   |-- transformation.test.ts
|           |   |-- transformation.ts
|           |   |-- transformations.test.ts
|           |   |-- workspace.test-support.ts
|           |   `-- workspace
|           |       |-- browser.test.ts
|           |       |-- browser.ts
|           |       |-- desktop-sequences.test.ts
|           |       |-- desktop.test.ts
|           |       |-- desktop.ts
|           |       |-- scripted-owner.test-support.ts
|           |       `-- types.ts
|           `-- routes
|               |-- +page.svelte
|               |-- components
|               |   |-- AppHeader.svelte
|               |   |-- AppShell.svelte
|               |   |-- ConnectionForm.svelte
|               |   |-- FileView.svelte
|               |   |-- PostProcessingControl.svelte
|               |   |-- RecordingDetail.svelte
|               |   |-- RecordingList.svelte
|               |   |-- RecoveryNotices.svelte
|               |   |-- RowSaveStatus.svelte
|               |   |-- SaveStatus.svelte
|               |   |-- SettingsForm.svelte
|               |   |-- TranscriptCard.svelte
|               |   |-- TranscriptionControl.svelte
|               |   |-- TranscriptionSettingsForm.svelte
|               |   |-- TransformationDetail.svelte
|               |   |-- TransformationList.svelte
|               |   `-- TransformationOutput.svelte
|               |-- recordings
|               |   `-- +page.svelte
|               `-- transformations
|                   `-- +page.svelte
|-- bun.lock
|-- docs
|   `-- adr
|       |-- 0445-vocab-saves-local-chats-and-syncs-saved-entries.md
|       |-- 0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md
|       |-- 0498-vocab-opens-one-local-folder-before-sign-in.md
|       |-- 0502-whispering-connections-own-request-destinations-and-credentials.md
|       `-- README.md (only the two changed index rows)
`-- packages
    |-- folder
    |   |-- package.json
    |   `-- src
    |       |-- browser-adapter.ts
    |       |-- files.ts
    |       `-- table.ts
    `-- svelte
        `-- src
            `-- flush-edits-on-hide.svelte
```

The image is binary evidence. The two deleted modules are reviewed as retired boundaries. Bounded read-only Opus 5.5 consultations read every current scoped text file in full, including paged reads of the long Whispering library and tests. The coordinator read both deleted modules at HEAD and inspected the Vocab image. Vocab consultation: `e9b4337a-1273-48f5-8f6e-bdaea435962a`; Whispering: `f74200fb-33f6-42bc-bf4e-490e205ef116`. Both completed successfully without permission denials. Native JSON reports are `/tmp/epicenter-final-vocab-cumulative-review.json` and `/tmp/epicenter-final-whispering-cumulative-review.json`.

Additional review transport and evidence files read:

```text
/tmp/
|-- epicenter-existing-app-prerequisites.patch
|-- epicenter-final-vocab-whisper-live-transfer.json
|-- epicenter-app-migration-scope-paths.json
|-- epicenter-final-vocab-cumulative-review.json
|-- epicenter-final-whispering-cumulative-review.json
|-- epicenter-obstacle-counter-before.ts
|-- epicenter-obstacle-counter-before.log
|-- epicenter-obstacle-counter-after.ts
|-- epicenter-obstacle-counter-after.log
|-- epicenter-whisper-final-repair-baseline.json
|-- epicenter-whisper-final-repair-worker.json
|-- epicenter-whisper-final-repair-followup.json
|-- epicenter-scope-vocab-types.log
|-- epicenter-scope-vocab-tests.log
|-- epicenter-scope-vocab-build.log
|-- epicenter-scope-whisper-types.log
|-- epicenter-scope-whisper-tests.log
|-- epicenter-scope-whisper-build.log
|-- epicenter-scope-vocab-types-final.log
|-- epicenter-scope-whisper-types-final.log
|-- epicenter-scope-draft-tests-final.log
|-- epicenter-scope-candidate-final-install.log
|-- epicenter-scope-vocab-final-types.log
|-- epicenter-scope-vocab-final-tests.log
|-- epicenter-scope-whisper-final-tests.log
|-- epicenter-scope-whisper-final-types.log
|-- epicenter-scope-whisper-final-build.log
`-- epicenter-scope-vocab-final-build.log
```


Coordinator context and evidence read before acceptance analysis:

```text
.agents/skills/
|-- computer-use-driven-iteration/SKILL.md
|-- git/SKILL.md
`-- writing-voice/SKILL.md
apps/
|-- vocab/evidence/opfs-migration.png
`-- whispering/evidence/
    |-- dirty-related-removal-cancel.png
    |-- migration-review.md
    |-- opfs-migration.png
    `-- related-draft-canceled-reloaded.png
docs/adr/
|-- 0445-vocab-saves-local-chats-and-syncs-saved-entries.md
|-- 0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md
|-- 0498-vocab-opens-one-local-folder-before-sign-in.md
|-- 0502-whispering-connections-own-request-destinations-and-credentials.md
`-- README.md
```

The coordinator reread the changed ADRs and proof records and inspected both
proof images. ADR 0498 and 0502 now record accepted implemented app decisions.
ADR 0476 remains Proposed because its broader native delivery acceptance has
not been established. Its browser references and canonical-save descriptions
were corrected after being flagged; this does not close native GUI acceptance.

## Clean candidate validation

Base: `401708bb48f69d9f4b138e5f4b1bf872251c0f35`. Candidate: `/tmp/epicenter-app-migration-scope-20261004`. Includes only the 107 app-owned paths above and the Vocab workspace lock entry.

| Command | Log | Result |
| --- | --- | --- |
| `bun install --frozen-lockfile --ignore-scripts` | Tool output | 2423 packages installed |
| `bun run --cwd apps/vocab typecheck` | `/tmp/epicenter-scope-vocab-types.log` | 0 errors, 0 warnings |
| `bun test apps/vocab/src/lib` | `/tmp/epicenter-scope-vocab-tests.log` | 105 pass, 677 assertions |
| `bun run --cwd apps/vocab build` | `/tmp/epicenter-scope-vocab-build.log` | Exit 0, static build |
| `bun run --cwd apps/whispering typecheck` | `/tmp/epicenter-scope-whisper-types.log` | 0 errors, 0 warnings; native tsc passed |
| `bun run --cwd apps/whispering test` | `/tmp/epicenter-scope-whisper-tests.log` | 437 pass, 3157 assertions |
| `bun run --cwd apps/whispering build` | `/tmp/epicenter-scope-whisper-build.log` | Exit 0, static build |
| `git diff --check` | Tool output | Pass in candidate and live app scopes |

Minimal lock blob: `/tmp/epicenter-vocab-minimal-bun.lock`. This contains HEAD lock contents with only `apps/vocab` workspace block from the working tree, preserving the unrelated root dependency change as unstaged.

## Findings reported before correction

1. `apps/vocab/src/lib/folder.ts` described a database name instead of the current OPFS directory. Corrected the comment.
2. `apps/vocab/src/lib/data.ts` said every edit used a conditional capture. Canonical edits overwrite whole documents; deletion and raw source repair use captures. Corrected the comment.
3. `apps/whispering/src/lib/workspace/browser.ts` described the OPFS workspace as having no directory and implied IndexedDB was its current data store. Corrected the comment to distinguish the private directory from the legacy database check.
4. `apps/vocab/evidence/local-folder-journey.md` described the earlier IndexedDB implementation without a historical label. Preserved the observations and old test counts; labeled it historical and linked current acceptance.
5. Vocab `WordMode`, `WordOutcome`, `WordReview`, `wordOutcome`, and `wordReview`, Whispering `RowReview`, `RowDraftStatus`, and `SaveState` had no consumers outside their modules. Kept the readable named policies and types, removed only their exports after browser verification finished.
6. Whispering's raw `SaveState.failed` comment said a thrown save wrote nothing. A throw proves no receipt, not no write. Corrected the comment only.

All newly touched files were reread in full after these corrections. Runtime behavior was unchanged. Both typechecks passed again, and the three draft test suites passed: 49 tests, 389 assertions (`/tmp/epicenter-scope-draft-tests-final.log`, `/tmp/epicenter-scope-vocab-types-final.log`, `/tmp/epicenter-scope-whisper-types-final.log`).

## Boundaries kept

- Vocab `word.svelte.ts` owns the lifetime and operation chain for one word, including exclusive row-versus-exact-repair ownership. Inlining it into list and focus views would duplicate that lifetime.
- Vocab `entries.svelte.ts` owns the saved list, exclusive content-derived creation, and deletion admission. `reread.ts` earns its boundary through callers in word and chat listings and prevents stale receipts from erasing other writers' rows.
- Vocab legacy import remains explicit and separate from ordinary folder writes. `legacy-source.ts` opens old account stores only on request; it uses committed `ids`/`get`, not the unrelated uncommitted SDK `rows` API.
- Whispering's session survives route changes. The library owns admission and path operations; `row-draft.svelte.ts` owns app policy over the folder row editor, while `editor.svelte.ts` owns conditional exact text editing. These are different invariants, not interchangeable wrappers.
- Browser and desktop workspace modules own acquisition. They keep native imports and key handling out of product components.
- Connection validation is shared by browser and native storage. Recipe resolution has several real consumers and owns the rule that a recipe cannot retarget a private key.
- Native failure injection acts as an outside program. It obstructs one named write, lets the folder perform and answer it, and removes only its empty obstacle and created empty parents. Existing occupied paths remain intact and counters are not spent. The revised tests cover step isolation and invalid or symlinked paths. This is part of the one-file publication migration, not unrelated native work.

## Current and proposed organization

No file move or merge is proposed. Current and proposed trees are identical. This is a boundary decision, not an assertion that every module must stay forever: retained modules each own a current caller-visible lifetime or invariant; no speculative file movement improves this migration:

```text
apps/
|-- vocab/src/lib/
|   |-- data.ts
|   |-- folder.ts
|   |-- entries.svelte.ts
|   |-- word.svelte.ts
|   |-- reread.ts
|   |-- inference.ts
|   |-- legacy-import.ts
|   |-- legacy-source.ts
|   `-- chat/
|       |-- chats.svelte.ts
|       |-- messages.ts
|       `-- session.svelte.ts
`-- whispering/
    |-- native/failure-injection.ts
    `-- src/lib/
        |-- session.svelte.ts
        |-- library.svelte.ts
        |-- row-draft.svelte.ts
        |-- editor.svelte.ts
        |-- connections.ts
        |-- recipe.ts
        |-- recordings/publish.ts
        `-- workspace/
            |-- browser.ts
            |-- desktop.ts
            `-- types.ts
```

The removed Vocab `resources.ts` was the account-bound normal opener; folder and inference acquisition now have separate lifetimes. Whispering's removed `TranscriptionSettingsForm.svelte` was the one-key/folder-settings form; the connection forms now share session-owned private settings drafts. Their HEAD contents were read to verify that the old boundaries were retired rather than silently left reachable.

## Commit scope

Wave one: Vocab keeps words and chats in one OPFS folder, with one retained word editor and explicit legacy import. The local-folder/chat prerequisites and their schema, tests, UI, Vite browser shim, and package/lock entries are necessary to compile and explain this migration. Do not stage root SDK, auth, Yjs, or unrelated lock changes.

Wave two: Whispering keeps canonical drafts across route and path operations and publishes recordings through one audio save followed by one row save. Existing connection/recipe work is inseparable in the final callers, library, settings, native host, and tests. Freeze-era prerequisite code uses the retired batch API and cannot be a standalone teaser commit at the current backend HEAD. Include those app-owned prerequisites in this coherent app wave.

## Cumulative review follow-up

Vocab full-file review found an unused `ChatSummary` export, four unused direct dependencies, a stale database test comment, and a real duplicate-key risk where the legacy import failure list combines row IDs from three tables. These were flagged before edits. Removed the unused export/dependencies and made the plain failure list unkeyed. Full changed-file rereads completed. Candidate frozen install still passes after the minimal Vocab lock entry was refreshed. Final Vocab suite/typecheck logs: `/tmp/epicenter-scope-vocab-final-tests.log`, `/tmp/epicenter-scope-vocab-final-types.log`.

Whispering full-file review found a recording-deletion window: only the recording draft was fenced, while related transcript drafts could save unconditional rows after deletion and recreate them. It also found a debug-only concurrent obstacle-counter reservation race, a dead `deleteResult` method, and stale copy/doc comments. Flagged before edits; a bounded implementation worker repaired them in `/tmp/epicenter-whisper-migration-final-repair-20261004`. The accepted repair and coordinator checks appear below. It includes failing-before/passing-after regressions, fence ownership, no auto-resolution of unknown saves, and full touched-file rereads.

Vocab final production build after package/export/import-list cleanup: `/tmp/epicenter-scope-vocab-final-build.log`. Additional context files above include partial folder table and browser-adapter reads; they are not claimed as full migrated files.


The counterexample run before the repair produced `placed: 2, rowWrites: -1` for two different stems and one armed row failure. It used real directories with the final input failure injection module, not a replacement implementation.

The worker found a second grounded path-operation overlap during acceptance. `submitFileChange` starts work immediately rather than queuing it; `renameFile` can later release a fence owned by recording deletion. This was reported before any live correction. The same dedicated worker added destructive-path admission regressions for both operation orders, preserving unrelated-file concurrency and unknown-outcome holds. Candidate source remained unchanged until acceptance; the resulting artifact has now been integrated with hash guards.

## Whispering repair acceptance

The dedicated Opus 5.5 worker completed the seven flagged repairs and one bounded follow-up. Session `be96b1fd-c6d2-4309-aace-d5c4efe249d8`; follow-up native result has `is_error: false` and no permission denials. The first worker turn's full suite had one loopback binding failure under its required sandbox, so the coordinator repeated final full tests outside that sandbox; all 444 passed.

Recording removal now refuses if any confirmed transcript or transformation result holds edits or a failed/unknown save. All related drafts are retired before the first awaited parent deletion. Each result deletion has its own receipt: earlier success stays done, a refused result keeps its draft, and untouched drafts resume if the parent refuses or the operation throws. A later matching read never acknowledges an unknown save automatically.

A private per-path command claim prevents a rename, removal, or unresolved-move choice from releasing another operation's fence. Claims are acquired before any await, include move destinations, and release in `finally`. The existing fenced and retiring sets continue to own draft write and typing policy. This earns a separate invariant: rename must settle its draft before fencing saves, while destructive command admission must already exclude another command. Unrelated paths retain concurrency. The `owning` helper has four real call sites; `retire` shares the same draft-state transition between standalone and multi-file deletion. No new module or public export is needed.

The new deletion and counter tests fail on input code and pass after repair. The overlap tests fail for both operation orders; a destination-less mutation fails the destination case. Focused library-driving suites pass 170 tests. Coordinator reproduced the real-directory counter example independently: before `placed: 2, rowWrites: -1`, after `placed: 1, rowWrites: 0`.

The worker reread all ten touched files in full after its first repair, then both library files in full after the follow-up. Coordinator inspected the resulting invariants, production callers, new regression bodies, and helper boundaries. Ten allowed Whispering paths were integrated into live and clean candidate only after every current input hash matched its recorded baseline. The Vocab newline difference in the worker clone was a coordinator normalization after dispatch, and was not copied back. The scope manifest hashes were refreshed; staging and commits remain parent-owned.

Known bounded limits: debug injection re-arming during an in-flight placement and simultaneous debug parent-directory creation were not expanded into production work. A result whose bytes changed since confirmation can be left behind after its recording was deleted; this is the explicit one-file-at-a-time partial outcome, and the app lists the leftover. This migration adds no multi-file transaction promise.

Final coordinator verification in the clean candidate, outside the Claude Bash sandbox:

| Command | Log | Result |
| --- | --- | --- |
| `bun run --cwd apps/whispering test` | `/tmp/epicenter-scope-whisper-final-tests.log` | 444 pass, 0 fail, 3229 assertions across 25 files |
| `bun run --cwd apps/whispering typecheck` | `/tmp/epicenter-scope-whisper-final-types.log` | Svelte 0 errors, 0 warnings; native tsc passed |
| `bun run --cwd apps/whispering build` | `/tmp/epicenter-scope-whisper-final-build.log` | Exit 0, static build |
| `git diff --check -- apps/whispering` | Tool output | Pass |

The browser proof files are separate additions after the original 107-path manifest: `apps/vocab/evidence/opfs-migration.md`, `.png`, and `apps/whispering/evidence/opfs-migration.md`, `.png`. Their text was reread; screenshots were generated and observed by the browser agent, not represented as code reads. Root-owned ADR-0445 supersession, ADR-0498 and ADR-0502 acceptance, ADR-0476 browser/opener alignment, and the two matching index rows were read as context. They are not app-worker changes. No remaining grounded production defect was found in the bounded acceptance review; this is not a claim that unseen native GUI or provider workflows were exercised.

## Final browser adjacency

The integrated candidate at localhost:5235 retained a paused dirty related
transcript while the recording deletion confirmation was open. Cancel, Save
now, re-enable automatic saving, and reload preserved both new fixture files
and the saved café transcript. No final Delete action was pressed: the app has
no demonstrated trash/restore route. Actual guard refusal and overlapping
operation timing remain automated evidence. The fixture's audio path is its
own absent file; existing migrated audio was untouched.

Additional evidence read before acceptance:

```text
apps/whispering/evidence/
|-- migration-review.md
|-- opfs-migration.md
`-- related-draft-canceled-reloaded.png
/tmp/
`-- whisper-opfs-related-draft-canceled-reloaded.png
```
