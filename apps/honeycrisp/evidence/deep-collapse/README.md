# Honeycrisp deep collapse evidence

Implemented by Codex and reviewed read-only by Claude Opus 5.5 on October 1, 2026.
The task-start baseline includes the earlier mechanical cleanup and selection-loading repair. The implementation commit before that cleanup is `0ae41773836a3514f78242ba500a9ddf1f84e82e`. Other chats changed shared file infrastructure during this work; this pass edits only Honeycrisp.

## Files read for this pass

Paths below are relative to the repository root. The earlier design conversation included its own inventory. The reviewer inventories, including their shared-library reads and read limits, appear before analysis in the linked reports.

```text
apps/honeycrisp/
|-- AGENTS.md
|-- README.md
|-- package.json
|-- host/
|   |-- serve.ts
|   `-- serve.test.ts
|-- src/lib/
|   |-- data.ts
|   |-- draft.svelte.ts
|   |-- draft.test.ts
|   |-- files.ts
|   |-- effects.test-support.svelte.ts
|   |-- svelte-modules.test-support.ts
|   |-- note-source.ts
|   |-- notes.svelte.ts
|   |-- notes.test.ts
|   |-- platform-selection.test.ts
|   |-- terminal.svelte.ts
|   |-- bridge/
|   |   |-- codec.ts
|   |   |-- contract.ts
|   |   |-- folder-client.ts (baseline, deleted)
|   |   |-- notes-host.ts
|   |   `-- transport.ts (new)
|   |-- editor/
|   |   |-- markdown.ts
|   |   |-- rich-session.ts
|   |   `-- schema.ts
|   `-- platform/
|       |-- notes-host.browser.ts
|       |-- notes-host.tauri.ts
|       `-- types.ts
|-- src/routes/components/
|   |-- DraftStatus.svelte
|   |-- FileBrowser.svelte
|   |-- FileNameBar.svelte
|   |-- FileView.svelte
|   |-- NoteDetail.svelte
|   |-- NoteHistory.svelte
|   |-- NotesView.svelte
|   `-- RichEditor.svelte
`-- evidence/deep-collapse/native-evidence.json
```

## What changed and why

One `openFiles` registry now owns every retained text draft. Selection decides whether that path has note controls or a raw editor. Rename and recovery retarget the same draft, preserving its identity. Separate note and raw editor maps, factory paths, and refresh loops disappeared.

Refresh now runs serially with one coalesced follow-up. It snapshots registry identities and accepted observations before listing. A result from an older pass cannot replace an editor accepted by a newer save, or remove a draft renamed during an awaited read. Generation counters disappeared.

`patchNote(path, fields, {save: 'now' | 'later'})` owns structured mutation. NoteDetail uses deferred saves for typing; list actions save immediately. An unopened action updates conditionally without creating an invisible draft.

The desktop bridge exposes the operations Honeycrisp consumes. The arbitrary remote-folder factory, unused KV and staged Git methods, file-child/open routes, and Blob conversion disappeared. `NotesFolder` picks methods directly from the runtime allowlist. Path, arguments and result types refer to the real library methods.

```text
Before                              After
src/lib/bridge/                     src/lib/bridge/
|-- codec.ts                        |-- codec.ts
|-- contract.ts                     |-- contract.ts
|-- folder-client.ts                |-- transport.ts
`-- notes-host.ts                   `-- notes-host.ts

notes.svelte.ts                     notes.svelte.ts
|-- note editors                    |-- openFiles
|-- raw openFiles                   |-- common editor factory
|-- separate observation loops      |-- serial observation pass
`-- metadata owner + UI mutation    `-- patchNote
```

Keep the four draft facts, RichSession, Markdown validation, source-preserving metadata operations, note-table attachment checks, native close handshake, browser adapter and native folder library. Collapsing those would remove guarantees or move their implementation into their callers. Explicit bridge forwarding earns compile-time method checking; a generic dispatcher would trade that away.

## Review findings and repairs

See [initial Opus review](opus-review.md) and [repair recheck](opus-recheck.md). Actual model: `claude-opus-5-5`; native session `4d67a881-e20e-4306-a984-5bf3bd34d1fe`. Both completed without errors or permission denials. Claude made no edits and ran no tests.

| Finding | Decision and evidence |
| --- | --- |
| Raw deletion accidentally used the note route | Repaired after Codex's second read, also independently found by Opus. Edited raw deletion and stale confirmed-version refusal tests pass. Final native UI deletion passes. |
| Stale listing briefly restores pre-save text | Deterministic test failed before repair, including observing the actual Svelte buffer. Snapshot accepted identity and reject stale observations. |
| Rename replaces another retained destination draft | Raw and note tests failed before repair. Refuse before moving either file; both drafts survive. |
| Missing non-text entry clears selected path; stale identity can erase a newer entry | Hoist identity check and preserve selected path for the missing-file screen. Added binary disappearance regression test after the recheck. |
| Runtime allowlist and TypeScript surface can drift | Derive Pick keys from the allowlist. Git snapshot events also carry their actual type. |
| Rename transport exception leaves controls busy | Catch and show the error in both name interfaces; clear busy state in finally. |

Opus closed all five findings and the transport concern in the repair recheck, with no remaining regression attributed to this diff. Its native evidence snapshot predates the final raw-delete check; the current JSON and screenshots include that check. The extra binary regression and clearer create-failure toast followed its recheck.

Nonblocking retained observations: a clean stale destination draft can briefly refuse rename until the next refresh forgets it. The pre-existing delete dialog does not catch a bridge transport exception. Stale loading abandonment and UI catch/finally paths have no dedicated regression test; the existing delayed-open selection, overlapping-open and awaited-refresh/rename tests cover adjacent paths.

## Second read of touched files

Each row records mental inlining, smells, invariant ownership, and API shape after edits. The reviewer provides an independent longer audit in its initial report.

| File | Inline and smell check | Invariant and API check |
| --- | --- | --- |
| README.md | Names the actual registry and concrete transport; removed stale KV bridge claim. | Contract table agrees with allowlist. |
| host/serve.ts | Removed dead KV and staged-authoring branches. Dynamic dispatch remains at the network edge. | Allowlist gates every call; saves still return independently of commits. |
| host/serve.test.ts | Real native-folder, bridge and draft behavior, rather than wrapper-shaped unit boundaries. | Conditional writes, rename retention, stale observation, delete and metadata policies exercised. |
| bridge/contract.ts | One operation list; typed path plumbing checked through concrete callers. | Snapshot event has GitSnapshot; NotesFolder derives its operation surface here. |
| bridge/folder-client.ts | Deleted; no remaining imports. | Arbitrary folder construction no longer promised. |
| bridge/transport.ts | HTTP and reconnect lifetime earn the file; no folder assembly or Blob shim. | Throws for transport faults; decoder casts stay at the wire boundary. |
| bridge/notes-host.ts | Explicit forwarding earns argument/result checking; Git/event lifetime is local. Removed redundant cast. | Close requests survive mounting and stream reconnect; abort owns stream shutdown. |
| files.ts | Existing read/path/tree helpers retain their callers. | Text reader needs only read; UTF-8, NUL, BOM and size handling unchanged. |
| notes.svelte.ts | Single registry and metadata owner; shared retarget owns rekey/rebase. | Selection dependencies, accepted identity, settled moves, destination drafts and conditional deletion checked. |
| notes.test.ts | Drives compiled Svelte effects and held reads. | Loading selection, open coalescing, refresh serialization and missing binary selection tested. |
| platform-selection.test.ts | Import graph test follows transport rename. | Browser/native/Yjs isolation still checked. |
| platform/notes-host.tauri.ts | New transport import; close fallback remains earned. | Native page still calls no Tauri command. |
| platform/types.ts | Pick keys no longer repeat method names. | Concrete browser/native surface; no KV, remotes or staged authoring promise. |
| DraftStatus.svelte | Common editor type; conflict interaction remains shared. | Explicit discard/overwrite choices still owned by the person. |
| FileBrowser.svelte | Existing keyboard/tree interaction kept; catch stays at presentation boundary. | Busy state clears on thrown create/rename; failures preserve name field. |
| FileNameBar.svelte | Shared file-name interaction still has multiple real callers. | Rename failure preserves input and clears busy state. |
| NoteDetail.svelte | Local patch delegates to one mutation owner. | Whole source remains sole draft; deferred save is explicit. |
| NoteHistory.svelte | Type rename only. | History restore still edits the current draft. |
| RichEditor.svelte | Type rename only; imperative view/session boundary retained. | No new per-keystroke mounting dependency or unchecked transaction. |

## Verification

- Final full suite: 168 tests, zero failures, 505 assertions across eight files.
- Browser and Tauri Svelte checks: zero errors and warnings; scripts TypeScript check passed.
- Browser production build and native release app build passed.
- Biome checks passed with existing/test non-null-assertion warnings; no unsafe fixes applied. Git diff whitespace check passed.
- Deterministic stale-listing and both destination-draft tests were run before fixing and all three failed, then passed after fixing.

The native app was run against `/private/tmp/honeycrisp-deep-native-root`, a disposable fixture with real Git. UI checks covered first raw open, editing across rename, continued saves at the new path, title/pin mutation, held-save external conflict, retained local text across selection, explicit save-mine resolution, Git history, quit and relaunch. The final rebuilt app created, edited and deleted a raw file through its confirmation dialog, reopened the saved note and quit successfully.

[Native assertions, hashes and Git log](native-evidence.json) record the final disk state. All original saved hashes remained unchanged through the final deletion check, and the Git working tree was clean after quit. The untouched Markdown file retained its exact bytes through both opening and relaunch.

- [Raw rename](raw-rename.png)
- [Retained conflict](conflict-retained.png)
- [Git history](history.png)
- [Relaunch](relaunch.png)
- [Final raw-delete confirmation](raw-delete-confirmation.png)
- [Final rebuilt app](final-native.png)
