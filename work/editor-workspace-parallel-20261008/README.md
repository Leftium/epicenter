# Honeycrisp and Capture workspace migration

## Outcome and execution boundary

Selection determines editing purpose: Files opens full text, product lists open structured controls, and invalid files have a named repair route. ADR 0507 remains Proposed. Todos implementation commit 6cc62b3f5f is the accepted reference. Implement Honeycrisp and Capture in independent clones, then review, integrate, verify in the actual UI, and commit one app at a time in the coordinating checkout. No shared package changes and no additional cleanup waves are assigned.

Source baseline e32ec483f58e182648261c13f9005be6340c53f7. The baseline includes the Todos commit and intervening unrelated commits. dispatch.json records isolated clone locations and transferred dirty dependency inputs. Each clone's coordinator-input.json records hashes. Exact app source snapshots before workers: /tmp/honeycrisp-workspaces-source-input-20261008 and /tmp/capture-workspaces-source-input-20261008. Compare returned artifacts against those snapshots, not only HEAD. Pre-existing app test work must remain separate from migration staging.

Both workers were launched through delegate-claude with high effort and the default claude-opus-5-5. Actual model/result and denials must be read before accepting the reports. Results: /tmp/honeycrisp-workspaces-worker.json and /tmp/capture-workspaces-worker.json. Each worker is the sole writer in its standalone clone. Codex owns live source, browser acceptance, review, integration, and staging. Shared package inputs are read-only in both assignments.

## Observed baseline

Actual native Safari computer-use, with disposable browser-origin data:

- Honeycrisp http://localhost:25864/: startup succeeds. Created notes/083f0057a8.md, title Honeycrisp workspace baseline, rich body Keep this note body. The note editor shows Rich text/Source tabs and Edit as file. Edit as file changes the same note detail into complete-text view with Open as note. This matches rawMode and path-inferred acquisition found in source.
- Capture http://localhost:25865/: startup succeeds. Created captures/20261008-065526-6p415.md, text Capture workspace baseline, thought Keep this thought across workspaces. Capture/Source tabs change the same draft's interpretation; Source displays complete frontmatter and body. No Files workspace currently exists.

These are observed product behaviors to replace, not claims of data loss. The migration follows the user's chosen editing contract.

## Baseline checks before worker integration

- Honeycrisp app script: 325 tests pass and 19 DOM tests pass, zero failures. /tmp/honeycrisp-workspaces-baseline-test.log.
- Capture app script: 87 pass, three failures in platform/folder.epicenter-host.test.ts. /tmp/capture-workspaces-baseline-test.log. Extra apply counts in failed A/B/C discard and failed reload tests; removed-file retry expected replacements only. These precede this wave's integration, and attribution beyond that is not established. Do not weaken assertions or modify shared packages merely to pass.
- Capture mounted UI: 13 pass, zero failures. /tmp/capture-workspaces-baseline-mounted.log. Svelte derived_inert diagnostic appears; inspect against final mounted lifetime changes rather than assuming it is a new regression.

## Acceptance after integration

For each app, verify one real browser journey spanning structured edit, full-text navigation, malformed-source repair with no automatic interpretation change, explicit structured reopening, A/B/A selection, and saved content after reload. Add a representative app-specific check: rich text/unsupported body in Honeycrisp; duplicate thought positions and preserved unsubmitted thought input in Capture. Failed publication and delayed-callback/handoff counterexamples need meaningful tests. Native interaction and provider acceptance remain separate from browser evidence and host compilation.

## Other search findings

A bounded production-source search found source/form switches in Whispering RecordingDetail.svelte, TransformationDetail.svelte, FileView.svelte and library.svelte.ts. This is a later candidate, not an accepted defect or assigned implementation. Honeycrisp and Capture remain the only workers in this wave. Avoid launching additional chats or workers merely because the pattern exists.

## Protection and remaining work

The live checkout contains unrelated dirty and staged changes. Snapshot /tmp/editor-parallel-device-before.patch protects the pre-existing staged packages/device/src/owner.ts patch. Stage specific accepted migration paths only, preserving transferred pre-existing test edits. Do not copy shared-package worker inputs back into the live checkout.

Additional baseline: Capture browser/host/scripts typechecks pass. Honeycrisp typecheck fails before integration at src/lib/status.ts:156: obsolete stoppedWaiting branch is incompatible with the current Folder commit outcome union. /tmp/honeycrisp-workspaces-baseline-typecheck.log. The worker has the same transferred shared dependency input. Resolve only the app-local obsolete branch if still present at final verification; do not alter shared outcomes.

Honeycrisp's nested AGENTS.md still prescribes rawMode, reused detail props, automatic malformed-note fallback, and a reload typing fence. These conflict with the user's explicit new doctrine. The current user request governs the migration. After implementation, reconcile the affected guidance using agent-instructions; keep real data/native-close constraints and route current architecture to the README/ADR instead of leaving contradictory instructions.

Pending: read worker native results, inspect app diffs against input snapshots, reproduce checks, post-implementation review with ASCII file inventory, integrate serially, actual browser acceptance against final source, document evidence and commit coherent app waves.

## Coordinator pre-integration review inventory

```text
apps/
|-- honeycrisp/
|   |-- AGENTS.md
|   |-- README.md
|   |-- package.json
|   `-- src/
|       |-- lib/
|       |   |-- notes.svelte.ts (acquisition, retention and caller sections)
|       |   |-- note-editor.svelte.ts
|       |   `-- status.ts (commit outcome branch)
|       `-- routes/
|           |-- +page.svelte
|           `-- components/
|               |-- NotesView.svelte (detail dispatch)
|               |-- NoteDetail.svelte
|               `-- RichEditor.svelte (props and widget ownership)
|-- capture/
|   |-- README.md
|   |-- package.json
|   `-- src/
|       |-- lib/
|       |   |-- captures.svelte.ts (listing, parsing and retention)
|       |   |-- draft.svelte.ts (admission, controls and recovery)
|       |   `-- components/
|       |       |-- CaptureApp.svelte
|       |       `-- CaptureDetail.svelte (mode and rendered controls)
|       `-- routes/+page.svelte
`-- whispering/ (read-only later-candidate trace)
    |-- README.md
    `-- src/
        |-- lib/library.svelte.ts (source/form commands)
        `-- routes/components/
            |-- RecordingDetail.svelte (Source/Details tabs)
            |-- TransformationDetail.svelte (Source/Instructions/Try tabs)
            `-- FileView.svelte (row/source dispatch)
```

Keep genuine rich widget document/selection/history and explicit-submit thought forms. Remove interpretation-selection state from editor admission. Shared detail layout is allowed; keyed view identity protects the currently addressed owner. Whispering's Try tab is an actual workflow and is not automatically a deletion candidate. Its three source/form surfaces share library ownership, so they are one future app migration rather than three independent workers. No Whispering changes in this wave.

Additional computer-use baseline in Honeycrisp: used its existing body Source control to save a table after Keep this note body. Rich text reports It contains a table and offers Continue in Source; the saved table remains visible through the existing source path. This disposable note now contains the table for post-migration verification: the future structured view should name the unsupported body and offer explicit Files navigation, without mounting a Source fallback or dropping the table. The assignment already covers unsupported body repair; this does not expand it.

Grounding: inspected the installed Svelte keyed-block implementation in apps/honeycrisp/node_modules/svelte/src/internal/client/dom/blocks/key.js and the shared UI Input/textarea destroy guards. Key identity chooses the branch; destroyed shared controls retire reads and writes. This supports keying by acquired owner, not row/body content, and retaining native command cleanup without copying shared binding guards into ordinary setters.

Broader read-only state search: Whispering's row-editing.svelte.ts owns a source boolean behind the three source/form surfaces. Vocab PhraseCapture.svelte's text state is an explicit-submit phrase form, not a copy of an accepted editor row; no removal proposed. Matter table.svelte.ts's acceptedBodies owns accepted input and publication above the disposable widget, preserving failed text across dialog closure; it is an accepted-content owner, not a second component draft. Keep it. Old next-decisions.md proposals predate the accepted Matter owner and are historical evidence, not a new assignment. This search found no further justified app migration beyond Whispering; it does not prove absence of every possible pattern.

## Capture returned artifact and review

Native result /tmp/capture-workspaces-worker.json: session 378233ee-113c-4bd4-ab61-78034b0ec882, is_error false, actual claude-opus-5-5, four Bash permission denials. Worker reports 91 unit tests passing plus the same three baseline failures, 18 mounted tests passing, typechecks/browser build passing. Host build was not verified because nested Bun was unavailable and its PATH correction was denied. These remain worker reports until reproduced. No access escalation requested.

Files read for the completed-artifact review (in addition to the earlier caller inventory):

```text
apps/capture/
|-- README.md
|-- scripts/browser-smoke.ts
`-- src/lib/
    |-- captures.svelte.ts
    |-- captures.test.ts
    |-- draft.svelte.ts
    |-- draft.test.ts
    |-- platform/folder.epicenter-host.test.ts
    `-- components/
        |-- CaptureActions.svelte
        |-- CaptureApp.svelte
        |-- CaptureDetail.svelte
        |-- FileDetail.svelte
        |-- Files.svelte
        |-- Recovery.svelte
        |-- Timeline.svelte
        |-- Workspace.svelte
        |-- capture-detail.mounted.test.ts
        |-- timeline.mounted.test.ts
        `-- workspace.mounted.test.ts
```

Accepted ownership: Capture already has one canonical row publisher per capture file; both set and setText use it. Separate view lifetimes need no publisher handoff or reacquisition. A draft let go and reacquired at the same path must get a new keyed detail. The worker found live-prop retargeting during keyed destruction and fixed details to read their owner once at mount. This is an identity reference, not a copy of accepted content.

Keep Workspace: it owns actual acquisition/render lifetime and is mounted by production and regression tests. Keep CaptureActions: it shares real More-menu and deletion-review behavior across both details. Files and FileDetail represent actual separate navigation/list/detail surfaces, not forwarding wrappers. Keep explicit thought-form input, list identity checks, native save/recovery and close accounting. The source/inputSource names still identify full-file text operations; a name-only churn is not required to eliminate view admission.

Pre-cleanup findings: browser-smoke.ts still assumes Source tabs and source-only fallback, so its selectors and navigation must follow Files. README's module table incorrectly claims capture text that could not be applied is retained, contradicting the reason-only refusal contract. Ordinary Textarea setters still duplicate shared binding retirement with mounted/fieldsLive guards; direct setters are sufficient for ordinary accepted text and Add-form input, while thought identity checks and asynchronous/menu command guards remain necessary. Update these specific consumers, then run integrated checks and actual browser journeys. No shared package cleanup.

Initial integration copied only worker-changed app source/README paths after checking live bytes matched the dispatch snapshot. Transferred shared inputs were hash-verified unchanged. apps/capture/src/lib/platform/folder.epicenter-host.test.ts contains one migration-only removed setView call beside its pre-existing dirty hunk; staging must exclude that prior hunk.


## Capture accepted and committed

Commit `39b6ab37c6` separates Timeline and Files. Codex reproduced 91 unit passes with the same three baseline host-folder failures, 18 mounted passes, browser/host/scripts typechecks with zero errors, and browser plus host builds. Logs: `/tmp/capture-workspaces-integrated-test.log`, `/tmp/capture-workspaces-final-mounted.log`, `/tmp/capture-workspaces-final-typecheck.log`, `/tmp/capture-workspaces-final-build.log`, `/tmp/capture-workspaces-final-host-build.log`. The baseline mounted derived_inert diagnostic remains. The updated browser smoke script typechecks; it was not executed.

Actual computer-use acceptance used a new Zen tab at `http://localhost:25865/` and disposable browser-origin data. Safari/Chrome were being used by other work, so their tabs/dialogs were left untouched. Created `captures/20261008-072751-071w2.md` (Capture round trip) and `captures/20261008-073041-715i5.md` (Second isolated capture). Added two identical thoughts; editing the second left the first unchanged. In Files, saved malformed capturedAt YAML plus unknown `owner: keep-me`; Timeline excluded the file and exposed its path/reason repair entry. Repair opened the exact source. After correcting YAML, Files stayed Files; Open as capture explicitly restored structured controls. A pending Add-thought form survived navigation to Files and back without entering the saved file. Cleared that disposable form, reloaded, and verified capture text, both thoughts and unknown metadata persisted. A/B/A selection kept both captures isolated.

Browser evidence does not establish native publication or provider behavior. No native hardware or provider acceptance was performed in this wave. The commit excludes the transferred pre-existing platform test hunk. The pre-existing staged device owner patch is byte-identical after committing.

## Honeycrisp reconciliation

The first worker completed with is_error false, actual claude-opus-5-5 and six Bash denials. Its initial artifact remains in `/tmp/honeycrisp-workspaces-20261008/coordinator-returned-workspace/`. Newer live Honeycrisp lifecycle work overlaps the artifact: ADR-0513 closes without flushing or prompting, removes the global admits callback and debounce timer, and permanently releases/disposes editors. A three-way integration preview found conflicts, so no initial Honeycrisp artifact was copied into the live app.

Current live app source was frozen at `/tmp/honeycrisp-workspaces-rebase-input-20261008/`, with hashes, and copied into the existing worker clone. The same session resumed with a bounded reconciliation assignment: keep the newer lifecycle, reapply only workspace separation, assess synchronous raw handoff admission with a concrete counterexample, and report checks against this new baseline. Followup: `/tmp/honeycrisp-workspaces-rebase-followup.txt`; result: `/tmp/honeycrisp-workspaces-rebased-worker.json`. Integration must compare against the new snapshot and preserve further concurrent edits. Native migrations remain outside this assignment.


Codex reproduced the newer live Honeycrisp baseline: 327 owner/unit tests and 19 DOM tests pass. Browser, desktop and scripts typechecks pass with zero errors/warnings (`/tmp/honeycrisp-workspaces-rebase-baseline-typecheck.log`). A transient SvelteKit reserved-filename error from another in-flight test disappeared when that task moved its file; no coordinator edit was made. Desktop computer use is currently contested: the intended Zen acceptance tab was retargeted to another task's localhost:5193 between native interactions. The in-app browser entrypoint is unavailable in this session. Do not attribute that navigation to the product. Retry acceptance only against the verified target/source, and report native/provider checks separately.


## Honeycrisp integrated review inventory

```text
apps/honeycrisp/
|-- README.md
|-- src/lib/dom.test-support.ts
|-- src/lib/editor/rich-text.ts
|-- src/lib/note-editor.svelte.ts
|-- src/lib/note-editor.test.ts
|-- src/lib/note-source.ts
|-- src/lib/notes.folder.test.ts
|-- src/lib/notes.svelte.ts
|-- src/lib/notes.test.ts
|-- src/lib/workspaces.test.ts
|-- src/routes/components/Detail.svelte
|-- src/routes/components/FileBrowser.svelte
|-- src/routes/components/FileView.svelte
|-- src/routes/components/FolderNav.svelte
|-- src/routes/components/Handoff.svelte
|-- src/routes/components/NoteDetail.dom.test.ts
|-- src/routes/components/NoteDetail.svelte
|-- src/routes/components/NoteList.svelte
|-- src/routes/components/NotesView.svelte
|-- src/routes/components/RichEditor.svelte
|-- AGENTS.md
|-- package.json
|-- src/lib/file-session.svelte.ts (current lifecycle and handoff caller)
`-- src/routes/+page.svelte (owner lifetime)
```


## Honeycrisp accepted behavior and review findings

The resumed worker returned is_error false, actual claude-opus-5-5 and three Bash denials. Its artifact changes 20 source/README paths against the newer input; file-session is unchanged. Each live destination matched that input byte-for-byte before copying. Current lifecycle files and all other dirty work were preserved.

Keep Detail: it owns acquisition-result dispatch and the keyed editor lifetime. Keep Handoff: it exposes the retained publisher's actual failure/retry/reload/discard/copy choices while a destination cannot open. Keep rich widget state, explicit link-form input, path operations and unconfirmed-outcome tracking. Remove rawMode, showFile, per-note Source tabs, selectedPath plus selection lookup, and reload typing fences. The row wrapper still owns operation/release/refusal policy rather than a duplicate accepted document.

The worker's counterexamples establish a smaller handoff promise than the initial ADR wording: raw input accepted before draining is carried forward; input accepted after the drain snapshot keeps the raw owner and stops the handoff. The current DOM retires its Files control on navigation; an old detached field takes nothing. No second publisher opens over unsaved input. Accept this behavior instead of restoring the removed generic admission callback. ADR 0507 now records that a late accepted edit may require asking to open the destination again, while rename/delete keep their own synchronous operation boundary. Ordinary close follows the newer departure policy, not a handoff flush guarantee. This is an explicit doctrine refinement, not a claim of strict session-level input fencing.

Coordinator reconciled Honeycrisp AGENTS guidance that still demanded rawMode, note repair through a row Source view, hot-swapped detail props and reload typing fences. New guidance routes architecture to README, keeps one publisher, current input and keyed detail constraints, and preserves newer native-close and data-safety instructions. Input guidance snapshot: `/tmp/honeycrisp-workspaces-guidance-input-20261008.md`.

Actual Safari acceptance at `http://localhost:25864/` used the prior disposable baseline note `notes/083f0057a8.md` and new `notes/5aa1ffe96b.md`. The unsupported table now names its reason and opens in Files without dropping it. Malformed title YAML stayed editable as exact source and became a named repair entry rather than an editable note. Repair stayed in Files; Open as note explicitly reopened structured fields. A title replacement preserved the table body and unknown `owner: keep-me`. Created Honeycrisp rich round trip with a rich body, opened Files to inspect its serialized text, reloaded, reopened both notes and completed A/B/A. Rich text, repaired title, table and unknown metadata all persisted. No native/provider acceptance is inferred from this browser evidence.

Codex reproduced 342 unit/owner passes and 25 DOM passes, browser build and desktop UI build passes. Logs: `/tmp/honeycrisp-workspaces-integrated-test.log`, `/tmp/honeycrisp-workspaces-integrated-build.log`, `/tmp/honeycrisp-workspaces-integrated-desktop-build.log`. Integrated typecheck currently fails in a concurrently edited, non-migration `src/routes/+page.svelte:19`: a logger literal supplies unsupported `cause` to LoggableError. The rebase baseline passed before that edit. No migration type error has been observed; do not call the current overall typecheck passing. The native lifecycle work is still dirty and overlaps workspace files, so it must be separated or committed by its owner before a workspace-only live commit can be audited safely. Do not stage the combined dirty app wholesale.


Final verification: coordinator fixed only the concurrent page teardown's logging type error, using a private defineErrors variant that preserves its name, message and cause. Close behavior is unchanged. Before-fix snapshot: `/tmp/honeycrisp-workspaces-page-before-log-fix.svelte`. Final browser, desktop and scripts typechecks pass with zero errors/warnings (`/tmp/honeycrisp-workspaces-final-typecheck.log`); all 25 DOM tests pass again (`/tmp/honeycrisp-workspaces-final-dom.log`). Browser/desktop UI builds preceded this logging-only change; neither is native runtime acceptance.

Capture is committed. Honeycrisp code, reconciled guidance and the logging fix are integrated and verified but remain unstaged because overlapping native lifecycle work is still uncommitted. `/tmp/editor-workspaces-honeycrisp-workspace.patch` preserves the reviewed migration-only delta against the newer lifecycle input; `/tmp/editor-workspaces-honeycrisp-log-compatibility.patch` preserves the small coordinator fix separately. Once that native baseline is committed, compare these deltas and stage only the accepted workspace changes. The ADR's committed progress can mark Capture complete; its Honeycrisp completion paragraph remains local until the app commit. No further workers were created; Whispering remains a later candidate. Preserve the staged device owner patch.
