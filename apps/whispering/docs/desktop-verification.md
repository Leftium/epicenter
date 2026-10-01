# Standalone desktop verification

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
