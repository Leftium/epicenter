<h1 align="center">Whispering</h1>
<p align="center">Record → transcribe → keep it all as files.</p>

Whispering is a standalone desktop app. It records audio, transcribes it with an
OpenAI-compatible endpoint you choose, and keeps every recording, transcript,
and setting as an ordinary file in one Git-versioned folder. It needs no
account, no Epicenter desktop, and no hosted API.

This is a development milestone, not a release. It demonstrates one workflow end
to end: launch, record, stop, save, play, transcribe, inspect files and history,
quit, reopen. [What is not supported](#what-is-not-supported) lists the rest.

## The data folder

```text
~/Epicenter/local/so.epicenter.whispering/
├── kv.json                          transcription endpoint and model
├── recordings/
│   ├── <recording-id>.md            title, time, length in frontmatter; notes in the body
│   └── <recording-id>.<extension>   the audio, with the extension its bytes call for
├── transcriptions/
│   └── <result-id>.md               names its recording in frontmatter; transcript in the body
└── .git/                            ordinary Git: Markdown, kv.json, and audio bytes
```

These files are the data. The app, the embedded terminal, and any other program
edit the same paths; there is no export step and no second copy. Set
`WHISPERING_DATA_ROOT` to use another directory, such as a disposable one for a
test.

A recording's ID is its file stem, set when the recording ends
(`20260102-030405-k3f9`). Its title is a field, so renaming a recording changes
frontmatter and never moves a file. Audio is committed as real bytes. There is no
LFS pointer and no LFS service.

## Run it

From the repository root. Rust and Bun are required, and `git` must be on `PATH`.

```sh
# The desktop app: builds the page and the folder host, then opens the window
bun dev:whispering

# The same app against a disposable folder
WHISPERING_DATA_ROOT=/tmp/whispering-demo bun dev:whispering

# A release bundle: apps/whispering/src-tauri/target/release/bundle
bun build:whispering

# The page alone in a browser tab, over a logical folder in IndexedDB
bun dev:whispering:ui
```

`bun dev:whispering` runs `tauri dev`. There is no hot reload: the page is built
once and served by the folder host. Use `bun dev:whispering:ui` for a fast UI
loop.

Checks, from `apps/whispering`:

```sh
bun run typecheck                 # the page, then the folder host
bun test --isolate                # folder host, bridge, publication, and workflow tests
bun run build                     # the page, into build/
bun run build:sidecar             # the compiled folder host, for the desktop bundle
cargo test --manifest-path src-tauri/Cargo.toml
```

### Environment

| Variable | Meaning |
| --- | --- |
| `WHISPERING_DATA_ROOT` | The data folder. Default `~/Epicenter/local/so.epicenter.whispering`. Created when absent. |
| `WHISPERING_TRANSCRIPTION_BASE_URL`, `WHISPERING_TRANSCRIPTION_MODEL` | Written to `kv.json` the first time a folder is opened. After that, `kv.json` decides. |
| `WHISPERING_TRANSCRIPTION_API_KEY` | The transcription key for this launch. Overrides the key saved from Settings. |
| `WHISPERING_AUDIO_FIXTURE` | Debug builds only. A file whose bytes answer every recording. See [Fixture audio](#fixture-audio). |
| `WHISPERING_BUN` | Debug builds only. The Bun executable that runs the folder host, when `bun` is not on `PATH`. |

## Using it

The header shows one status line, then Settings, Reveal folder, Files, and
Terminal on the right.

| Control | What it does |
| --- | --- |
| Record / Stop | Records, then saves the audio and its row to `recordings/`. The new recording opens. |
| A recording | Details: play the audio, change the title, transcribe, write notes. Source: the row's Markdown. Both edit one draft. |
| Transcribe | Sends the saved audio to the endpoint in Settings and saves the answer as a row in `transcriptions/`. |
| Status | Saved files, uncommitted changes, the last commit attempt, and the folder path as separate lines, with Check again and Commit now. |
| Settings | Endpoint and model (saved in `kv.json`) and the API key (kept on this device, outside history). |
| Reveal folder | Opens the data folder in Finder. |
| Files (Ctrl+B) | The folder's files. A recording row opens its details; an audio file opens a player; other text opens in a plain editor. |
| Terminal (Ctrl+\`) | Commands in the data folder. Its output, history, typed command, and directory stay when it is hidden. |

### Saved is not committed

A save writes files. A commit records them in history. They are separate
outcomes and the status reports them separately.

- Every content save through tables, KV, or Files requests a commit automatically.
  Typing saves after a short pause.
- A commit that fails or is blocked never undoes a save and never reports the
  save as failed. The status says "Saved" and what happened to the commit, and
  **Commit now** tries again.
- The browser terminal follows the folder's automatic history policy and refuses
  `git add` and `git commit` in automatic mode. Staged authoring requires a folder
  opened with `commitOnEdit: false`.
- Desktop terminal commands and other programs edit disk directly. Their changes
  enter the next automatic checkpoint or an explicit commit.

### When a save does not finish

Captured audio stays in the window until the folder has both files. If writing
stops partway (the audio is saved and its row is not), the recording appears at
the top of the list with what happened, a player for the audio held in the
window, and **Try again**. Trying again keeps the recording's ID, writes only
what is missing, and cannot create a second recording. If another file already
occupies the recording's path and is not this recording, nothing is overwritten
and the recording stays pending.

A transcript whose result file could not be written is kept the same way: the
status says a transcription is not saved, and the recording offers "Save it
again".

Pending audio, an unsaved transcript, and unsaved typing live only in the open
window. They are not written anywhere else.

### Closing and quitting

Closing the window (the close button or Command-W) and quitting (Command-Q or
the Whispering menu) both ask the window first:

- When nothing is held, typing that can still be saved is saved and the app
  closes with no prompt.
- When something is held (a recording in progress, a recording that is not in
  the folder, a transcript whose file was not written, a running transcription,
  or edits that cannot be saved), the app stays open and shows what would be
  lost. **Keep working** closes the prompt and changes nothing. **Discard and
  quit** closes the app and drops what was held.

The app closes only on an explicit answer from the window. A window that is
busy or slow keeps the app open until it answers; closing again only asks
again.

If the part of Whispering that reads and writes the folder stops while the
window is open, nothing more can be saved, but what the window holds is still
there: a pending recording still plays and unsaved text can still be copied.
Closing or quitting then shows the same prompt with that explained, and the app
stays open until you choose **Discard and quit** (or **Quit** when nothing is
held).

This covers an ordinary close or quit. It does not cover the process being
ended from outside: Force Quit, `kill`, a crash, or power loss discard whatever
was only in the window, and nothing can recover it afterwards. Force Quit is
also the only way out if the window itself stops responding, or shows the
"Could not open the recordings folder" screen, since a window that cannot
answer is never closed on its behalf.

In a browser tab (`bun dev:whispering:ui`) the browser's own leave warning
applies instead.

### Changes from outside

The app notices changes to the folder from any program within about a second.

- An editor with no unsaved typing shows the new content.
- An editor with unsaved typing keeps it, stops saving, and shows a conflict.
  **Show saved version** displays the file as it is now. Then choose: discard
  yours and load the saved file, save yours over it, or **Keep both**, which
  writes your text to `conflicts/<name>-<time>.md` and loads the saved file.

A recording row whose frontmatter cannot be read, or lacks a field, stays in the
list marked "Needs repair" with its file untouched. Fix it in Source. Fields the
app does not know are kept as written.

### The terminal

On the desktop the terminal runs your own shell (`zsh`, `bash`, or `sh`) with
the data folder as its working directory, so `git log`, `git status`, `cat`,
`sed -i`, and redirection work on the real files.

It is not an interactive terminal. Each command runs in a new shell that starts
where the last one ended, so `cd recordings` holds but shell variables and
functions do not. There is no terminal device, so full-screen programs such as
`vim` or `less` exit at once; `git` output is not paged. A command that leaves
the data folder returns to its root. A command is stopped after two minutes.

Avoid making files executable in the data folder: automatic commits write plain
files only and report "Commit blocked" while an executable file is present.

## Fixture audio

For repeatable automation, a debug build can answer every recording with the
bytes of one file:

```sh
WHISPERING_DATA_ROOT=/tmp/whispering-demo \
WHISPERING_AUDIO_FIXTURE=/path/to/tone.wav \
bun dev:whispering
```

The header shows a "Fixture audio" badge and the Record button says the
microphone is not used. Recordings made this way are saved with
`capture: fixture` and labelled in the list and in details. A release build
refuses the variable, says so beside the Record button, and records from the
microphone.

A fixture recording proves the save, playback, transcription, and history path.
It proves nothing about the microphone. Test the microphone separately.

## Failures you can cause on purpose

A debug build has a bug-icon menu in the header:

| Control | Effect |
| --- | --- |
| Pause autosave | Typing stays unsaved until "Save now", so an outside edit can be raced against a draft. |
| Fail the next recording file write | The next save lands the audio and fails the row: a partial publication. Each press arms one more. |
| Fail the next audio write | The next save fails before anything is written. |
| Lock the branch | Creates a lock on the branch ref, where an interrupted Git process leaves one, so commits fail while saves succeed. Press again to unlock. It never replaces a lock that already exists and only ever removes the lock it created. |

The same failures can be armed at launch with
`WHISPERING_DEBUG_FAIL_ROW_WRITES=<n>`, `WHISPERING_DEBUG_FAIL_AUDIO_WRITES=<n>`,
and `WHISPERING_DEBUG_BLOCK_COMMITS=1`. To cause the commit failure by hand in
any build:

```sh
touch "$WHISPERING_DATA_ROOT/.git/refs/heads/main.lock"   # commits now fail
rm "$WHISPERING_DATA_ROOT/.git/refs/heads/main.lock"      # Commit now works again
```

## Restoring from history

History is ordinary Git, so a recording can be recovered without the app:

```sh
git -C "$WHISPERING_DATA_ROOT" log --oneline -- recordings/
git clone "$WHISPERING_DATA_ROOT" /tmp/whispering-restore
afplay /tmp/whispering-restore/recordings/<recording-id>.wav
```

## What is not supported

These are absent, not hidden behind a setting:

- Accounts, sign-in, sync between devices, and any hosted transport. Recordings
  are local.
- Git remotes, push, and pull from the app. Use `git` in the terminal.
- Git LFS.
- Global shortcuts, push-to-talk, voice-activated recording, and delivering text
  to the cursor or clipboard automatically.
- On-device transcription models. Transcription needs an endpoint.
- Transcript cleanup, importing audio files, choosing an input device, and
  recording overlays.
- Windows and Linux are untested. The terminal needs a POSIX shell.
- A release pipeline. `bun build:whispering` produces a locally signed bundle.
- Running inside the Epicenter desktop host as a native app. `bun run
  build:epicenter` still emits the page for that host, where it runs as a
  browser page over a logical folder. The host's Whispering commands in
  `apps/epicenter/src-tauri` are no longer called by this app.

The earlier Whispering stored recordings in a Yjs store. Nothing reads that
data. There is no migration.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit, and
[desktop verification](./docs/desktop-verification.md) for native acceptance
results, screenshots, and the microphone hardware limit.
