# Standalone desktop verification

This file has three dated parts. The first records the adoption of the shared
folder package, which has automated checks only. The second records the
restored pages and transformations. The third retains the earlier
single-window acceptance.

## Shared folder adoption (October 1, 2026)

Whispering now uses `@epicenter/folder` and `@epicenter/definition` in place of
the folder code that lived in `@epicenter/app`. A recording names its audio in
`audioPath`, a recording is published as one folder batch, and deleting a
recording keeps its audio. The Bun folder host is still the desktop folder's
only owner.

**The desktop app was not launched for this change.** Claude Opus 5.5 made it
in an isolated checkout whose sandbox allowed no window, no shell launch, and
no network. Nothing below is native acceptance, and the native results in the
later parts of this file were observed before this change: they do not
establish how this build behaves in the desktop app.

| Check | Result |
| --- | --- |
| `bun test --isolate` in `apps/whispering` | 192 passed, 0 failed, 16 files |
| Page TypeScript (`svelte-check`) and host TypeScript (`tsc -p tsconfig.native.json`) | Zero errors and warnings |
| `vite build` with `NODE_ENV=production` | Passed; the emitted page contains no desktop folder adapter |

The tests run the real product state over a real directory and Git repository,
and the host tests cross the real bridge encoding. Publication failures in them
are the folder's own: a directory is put in the way of one step of the real
batch. No test uses a window, a WebView, a microphone, or a provider.

Not done, and needed before this can be called accepted on the desktop:

- Launch `bun dev:whispering`, record, play, transcribe, transform, quit, and
  reopen against a disposable folder.
- Exercise both debug publication failures and **Try again** in the window.
- Open a data folder written by the earlier build and confirm its recordings
  show "Needs repair" with no audio, and that adding `audioPath` repairs one.
- Build the compiled folder host (`bun run build:sidecar`) and the release
  bundle. Neither was built here.
- `cargo test --manifest-path src-tauri/Cargo.toml`. The shell was not changed
  and its tests were not run.

## Pages and transformations (October 1, 2026)

Claude Opus 5.5 implemented the recorder home, `/recordings`, and
`/transformations` in an isolated checkout. Codex reviewed and integrated the
work while preserving concurrent storage changes. GPT-6.1 independently
reviewed the recovery corrections and exercised the browser and native UI.

Native fixture checks passed through recording, transcription, transformation,
conflict handling, and retry recovery. Native acceptance is incomplete: the Mac
locked before the final resize, reload, and quit/reopen checks. No lock bypass
or forced quit was attempted. The app was left open with its managed work saved.

### Automated and browser checks

| Check | Result |
| --- | --- |
| Implementation checkout tests | 143 passed, 840 assertions, 14 files |
| Combined checkout tests, including subsequent shared storage changes | 152 passed, 883 assertions, 15 files |
| Page and native TypeScript | Zero errors and warnings |
| Standalone debug and release builds, including page and compiled sidecar | Both passed |
| Independent browser workflow | Recording across routes, explicit transcription and transformation, unchanged original transcript, Back, reload, and narrow navigation passed with no page errors |

The browser used a fresh disposable IndexedDB profile, fixture audio, and a
real deterministic loopback endpoint. That evidence does not establish native
filesystem, shell, or microphone behavior. Its browser and Vite process were
closed afterward.

### Native checks performed

GPT-6.1 launched the exact active debug `.app` with a fresh
`/tmp/whispering-ui-restore-evidence/native-root`, a labeled three-second tone,
and endpoint `http://127.0.0.1:18081/v1`. The debug shell runs `native/main.ts`
from the checkout and serves the built page. This was not a compiled release
UI acceptance run. Observation-time source, page, executable hashes, process
start times, and checkout revision are recorded in the runtime evidence.

| Check | Observed result |
| --- | --- |
| Three pages and shared live capture | Native document URLs changed between all three routes; capture and timer continued; stopping saved one recording |
| Rename, playback, transcription | Saved title changed; native playback reached three seconds; explicit transcription sent exact fixture bytes |
| Transformation | Saved prompt and model produced a separate linked result; exact request matched its saved snapshots |
| Original transcript | Byte-for-byte unchanged after both transformations and result-save recovery |
| Draft and external conflict | Source draft and unknown metadata survived routes; both versions remained visible; Keep both preserved the draft in a separate file |
| Terminal lifetime | Working directory, output, history, and half-typed command survived hiding and route changes |
| Running and received unsaved results | Cmd-W and Cmd-Q warned; cancellation preserved the work across routes |
| Recording deletion | Refused while its transformation was running or its received output was unsaved |
| Result-save retry | Kept result ID `20261001-064741-43u4`, wrote exactly one file, and made no second provider call |
| Pending audio | Publication failure retained 96,044 bytes and ID across routes; retry saved one row/audio pair with that ID |
| Files | Saved result opened as ordinary Markdown with source relationships, prompt/input snapshots, and output body |
| Native files and Git | Ten ordinary files tracked; clean status and `git fsck --full`; separate HEAD restoration reproduced all files |
| Audio restoration | Both current and restored WAVs decoded as three-second mono 16 kHz PCM with the fixture hash |
| Credential | Dummy test key absent from all saved files; authorization headers omitted from endpoint logs |

The unchanged original is `transcriptions/nebf1x7wzd.md`, SHA256
`44c45f8ab97acbe5b1a82123a00d032a7f0c8d9e779a375d7b4cc49381a1a69d`.
Its recording is `20261001-064425-s22q` and the reusable profile is `9g4wgnkhv9`.
Both results retain those links. Native endpoint sequences 8 through 10 are
separate from browser requests 5 through 7 and tooling self-checks 1 through 4.

Evidence and thirteen native screenshots are retained in
`/Users/braden/.codex/artifacts/whispering-ui-restore-20261001/`:

- `independent-acceptance.md`: independent report, commands, and limits.
- `screenshots/native-01-home.png` and `native-02-recordings.png`: restored layout.
- `screenshots/native-10-transformations-top.png` and `native-11-transformations-results.png`: prompt editor and complete result bodies.
- `screenshots/native-04` through `native-09`: draft, conflict, terminal, and close/retry recovery.
- `screenshots/native-12-pending-audio-navigation.png` and `native-13-output-source-files.png`: audio recovery and Files source.
- `logs/native-filesystem-git.json`, `native-provider-assertions.json`, `unsaved-output-retry.json`, `privacy-assertions.json`, and `native-runtime-provenance.json`: assertions and runtime provenance.
- `source-checks/`: automated checks, build logs, and source reviews.

### Remaining checks

The locked Mac blocked new native narrow resizing/navigation, direct route
startup, history back/forward, successful reload, saved quit/relaunch and replay,
Finder reveal, malformed profile/result repair, and explicit transformation
discard/quit. Cmd-[ did not navigate in the shell. Cmd-R and resize returned the
Mac-lock error, so neither is claimed successful. Browser Back, reload, and
narrow layout passed separately.

No real provider or microphone was used in this pass. The earlier release
microphone attempt found zero input devices. Fixture audio proves state,
playback, saved bytes, request contents, and history; it does not prove speech
capture or transcription accuracy. The unchanged Rust shell tests were not
rerun for this UI slice. Global dictation and the other unsupported features
remain listed in `README.md`.

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
