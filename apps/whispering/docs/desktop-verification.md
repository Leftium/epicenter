# Standalone desktop verification

This file has two dated parts. The first records what has and has not been
checked since the pages and transformations were added. The second is the
earlier native acceptance of the single-window app, kept as it was written.

## Pages and transformations (October 1, 2026): not yet verified natively

The app now has three pages (`/`, `/recordings`, `/transformations`) under one
session, and transformations. Claude Opus 5.5 implemented this in an isolated
checkout. Codex integrated it into the active branch, preserving concurrent
folder lifecycle and publication changes, then reran the checks below.

Established by automated checks in that checkout, with a fixture capture device
and deterministic endpoint stubs (functions in place of `fetch`; no socket, no
provider, no key):

| Check | Result |
| --- | --- |
| Application tests in the implementation checkout | 143 passed, 840 assertions, across 14 files |
| Application tests after integration (`bun test --isolate apps/whispering`) | 151 passed, 879 assertions, across 15 files |
| Page TypeScript (`svelte-check`) and host TypeScript (`tsc -p tsconfig.native.json`) | Zero errors, zero warnings |
| Page build (`vite build`) | Passed |
| Standalone debug and release Tauri bundles, including compiled sidecar | Both passed |
| Transformation request shape, answers, and errors | Covered by `src/lib/transformation.test.ts` |
| Result publication, original transcript untouched, failed-save retry identity | Covered by `src/lib/transformations.test.ts` |
| Host sends with the device key and returns none of it | Covered by `native/host.test.ts` |
| One session per layout; page changes keep held work | Covered by `src/lib/session.test.ts` and `src/lib/page-boundary.test.ts` |

GPT-6.1 also exercised a fresh browser profile with Playwright against
`bun dev:whispering:ui --port 5518` and a deterministic loopback endpoint.
Fixture recording survived all three routes; stopping, transcribing, creating
and running a transformation, Back, reload, and narrow bottom navigation
passed with no page errors. The original transcript stayed unchanged. This
uses the logical IndexedDB folder and establishes browser behavior only.
The dedicated browser and Vite process were closed afterward.

Browser screenshots are retained in
`/Users/braden/.codex/artifacts/whispering-ui-restore-20261001/screenshots/`.

Not established:

- **The desktop app has not been run with these changes.** Layout, navigation,
  focus, and interactions on the three pages still need native checks. The earlier native
  acceptance below was of a different screen and does not carry over.
- **No real provider or key was used.** No request reached a chat or
  transcription service.
- **No real microphone was used.** The Mac this was built on has no audio input
  device; that limit is unchanged from the earlier part.
- The Rust shell was not changed and its tests were not rerun here.

Integrated check logs and review evidence are retained in
`/Users/braden/.codex/artifacts/whispering-ui-restore-20261001/source-checks/`.

Native scenarios that should be checked before this is called accepted:

1. Launch on `/`. Record with fixture audio, stop, and see the recording under
   the recorder. Press Transcribe against the deterministic endpoint.
2. With a recording running, visit Recordings and Transformations. The header
   shows the elapsed time and Stop on both; stopping from there saves it.
3. Open `/recordings` and `/transformations` by address and by refresh. Use back
   and forward.
4. Start typing a title with autosave paused, run a terminal command, visit the
   other pages, and return: the typing, terminal output, history, typed command,
   and directory are as they were.
5. Create a transformation from a starter, set a model, and run it on a
   transcript from both the Transform menu and the transformation's page. Check
   the new file in `transformation_runs/`, that the transcription file's bytes
   and hash are unchanged, and that both are committed.
6. Make the endpoint refuse, then answer: the notice shows the failure with Try
   again, on every page, and the retry lands in one file.
7. Make the result write fail (for example, make `transformation_runs` a file
   or read-only), then fix it: Save it again writes the file with no second
   request to the endpoint, and the status and close prompt name the unsaved
   result in between.
8. Edit a transformation file from the terminal while its editor is clean, and
   again while it is dirty: the first refreshes, the second shows the conflict
   and Keep both. Break its frontmatter and repair it in Source.
9. Delete a transformation and confirm its results remain.
10. Command-W and Command-Q from each page while something is held, and after
    stopping the host.
11. Files and Terminal from each page; Reveal folder; the debug failure
    controls. Files is now Ctrl+Shift+E, because Ctrl+B toggles the sidebar.
12. A narrow window (under 768 pixels): bottom navigation, list and details
    taking turns on both list pages.
13. Confirm the device key is absent from the page's network responses, the
    folder, and `git log -p`.

## Standalone single-window app (October 1, 2026)

Verified on October 1, 2026 on macOS. Claude Opus 5.5 implemented in an isolated checkout through the repository delegation workflow. GPT-6.1 independently operated the native Tauri app through CUA and inspected files and Git. Codex integrated the changes into the active file-folder branch, preserving concurrent Todos and Honeycrisp work.

The fixture workflow passed end to end in the standalone native app: launch, record, stop, save, rename, play, transcribe, inspect files and history, quit, and reopen. Real microphone capture was attempted separately in the release app and failed because this Mac Studio exposed no audio input device. Actual microphone capture and its permission prompt remain unverified.

## Commands

Run from the repository root:

```sh
bun dev:whispering
WHISPERING_DATA_ROOT=/tmp/whispering-demo bun dev:whispering
bun dev:whispering:ui
bun build:whispering

bun test --isolate apps/whispering
bun run --cwd apps/whispering typecheck
cargo test --manifest-path apps/whispering/src-tauri/Cargo.toml
```

The desktop command launches only Whispering. The browser command uses the logical browser folder. The release bundle is under `apps/whispering/src-tauri/target/release/bundle/`.

## Results

| Check | Result |
| --- | --- |
| Fresh launch without account or Epicenter desktop | Passed in standalone Tauri |
| Fixture capture, stop, save, rename, playback | Passed; native controls played three seconds |
| Deterministic transcription | Passed; endpoint received the exact 96,044-byte fixture and the result appeared in the UI and its separate row |
| Files, Source, terminal edits, Finder reveal | Passed against the actual native folder |
| External edit and dirty-draft conflict | Passed; clean views refreshed, both conflicting versions survived |
| Malformed row repair | Passed; unknown frontmatter and body survived |
| Partial publication and retry | Passed; audio stayed playable and retry kept the original ID without duplication |
| Commit failure and recovery | Passed; files remained saved while status reported failed history, then manual commit succeeded |
| Quit and reopen | Passed for saved recordings and transcript, including playback |
| Ordinary Git restoration | Passed; four WAVs restored into a separate location, each with the exact fixture hash and successful FFmpeg decoding; no LFS pointers |
| Unsaved native close | Passed after repairing an independently reproduced loss; Command-W and Command-Q warn, cancellation retains audio, explicit discard exits |
| Host termination while holding audio | Passed; cancellation retains playable audio and explicit discard permits quit |
| Real microphone | Attempted twice; failed with no input devices reported by macOS and WKWebView |
| Application tests | 73 passed, 368 assertions |
| Shared file-folder tests | 90 passed, 492 assertions, including the current Todos changes |
| Rust tests | 8 passed |
| Page and native TypeScript | Passed with zero diagnostics |
| Browser build, sidecar, debug and release desktop bundles | Passed |
| Required workflow Yjs removal | Native and page import graphs contain no Yjs runtime; all 16 production client JavaScript files were inspected |

The initial unsaved-close failure and the subsequent successful retest are both retained in the evidence. Fixture audio verifies publication, playback, endpoint transport, and Git restoration. It does not verify microphone capture or speech-recognition accuracy. The deterministic endpoint returned a fixed response; a real transcription provider was not tested.

The repository-wide structure check still reports pre-existing documentation-path, API-path, and vocabulary findings, reproduced against the baseline. The remaining product-startup failures for LocalMail and Vocab were also reproduced against the baseline. Catalog pins, UI boundaries, and boot purity passed. These unrelated failures were not repaired in this milestone.

The committed implementation also passed all 73 tests and both typechecks against the committed file-folder API in the isolated checkout. Uncommitted Todos API changes are not required for Whispering to typecheck or pass its application tests.

## Evidence

The local evidence archive is [whispering-file-desktop-20261001](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/independent-acceptance.md). It contains 22 native screenshots, endpoint uploads, filesystem assertions, build and test logs, the disposable native folder with its Git history, and a separate restored folder.

- [Independent acceptance table](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/independent-acceptance.md)
- [Native interaction observations](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/native-ui-notes.md)
- [Final filesystem and Git restoration assertions](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/logs/native-final-filesystem-and-history.json)
- [Yjs import and bundle evidence](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/logs/no-yjs-import-closure.json)
- [Recording and result](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/04-native-recording-result.png)
- [Files explorer](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/05-native-explorer-audio.png)
- [Terminal and Git history](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/06-native-terminal-git.png)
- [Conflict recovery](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/07-native-conflict-both-versions.png)
- [Commit failure status](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/09-native-git-failure-status.png)
- [Unsaved close confirmation](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/16-native-closeguard-command-q.png)
- [Real microphone failure](/Users/braden/.codex/artifacts/whispering-file-desktop-20261001/screenshots/22-native-microphone-invalid-constraint.png)

## Limits

Accounts, sync, hosted transport, LFS, migration, legacy readers, global shortcuts, voice activation, automatic text delivery, local transcription models, and audio import are absent. Windows and Linux are untested. The bundle is locally signed, without a release or notarization pipeline.

The embedded terminal retains its directory, output, history, and typed command. Each command starts a new shell; it has no PTY or persistent shell variables, functions, or interactive full-screen programs.

Unsaved audio, transcripts, and drafts live only in the window. Ordinary close and quit request explicit approval before discarding them. Force Quit, a crash, power loss, or external process termination can still lose that memory. A window that cannot respond requires Force Quit. See the [app README](../README.md) for operation and the full unsupported-feature list.
