<h1 align="center">Whispering</h1>
<p align="center">Record → transcribe → transform → keep it all as files.</p>

Whispering is a standalone desktop app for voice notes. It records audio,
transcribes it with an OpenAI-compatible endpoint you choose, turns a transcript
into another text with prompts you write, and keeps every recording, transcript,
prompt, result, and setting as an ordinary file in one Git-versioned folder. It
needs no account, no Epicenter desktop, and no hosted API.

This is a development milestone, not a release. Its voice-note workflow is launch, record,
stop, save, play, transcribe, transform, inspect files and history, quit, reopen.
Native verification results and remaining checks are recorded below. Dictating into other apps is not part
of it. [What is not supported](#what-is-not-supported) lists the rest.

## The data folder

```text
~/Epicenter/local/so.epicenter.whispering/
├── kv.json                          transcription endpoint and model
├── recordings/
│   ├── <recording-id>.md            title, time, length, and audioPath in frontmatter; notes in the body
│   └── <recording-id>.<extension>   the audio that row names, with the extension its bytes call for
├── transcriptions/
│   └── <result-id>.md               names its recording in frontmatter; transcript in the body
├── transformations/
│   └── <transformation-id>.md       title, model, endpoint in frontmatter; the prompt in the body
├── transformation_runs/
│   └── <run-id>.md                  what it was made from and with in frontmatter; the result in the body
└── .git/                            ordinary Git: Markdown, kv.json, and audio bytes
```

Opening the folder creates `kv.json` and Git metadata. Recording, transcript,
prompt, and result files are created by explicit actions. A folder has no
`transformations/` until you create a transformation.

These files are the data. The app, the embedded terminal, and any other program
edit the same paths; there is no export step and no second copy. Set
`WHISPERING_DATA_ROOT` to use another directory, such as a disposable one for a
test.

A recording's ID is its file stem, set when the recording ends
(`20260102-030405-k3f9`). Its title is a field, so renaming a recording changes
frontmatter and never moves a file. Audio is committed as real bytes. There is no
LFS pointer and no LFS service.

A recording's file names its audio in `audioPath`, such as
`audioPath: recordings/20260102-030405-k3f9.wav`. That line is the only link
between the two files:

- The app plays, transcribes, and lists only the file `audioPath` names. A file
  that merely has the same name with another extension is an ordinary file and
  is not treated as the recording's audio.
- A recording file with no `audioPath` is listed as "Needs repair" and has no
  audio to play or transcribe. This includes any recording file written before
  the field existed. The app does not fill the path in for you: add the line in
  Source, or with any editor.
- The audio file cannot be renamed from the app while a recording names it,
  since nothing would update the recording.

## Run it

From the repository root. Rust and Bun are required, and `git` must be on `PATH`.

```sh
# The desktop app: builds the page and the host, then opens the window
bun dev:whispering

# The same app against a disposable folder
WHISPERING_DATA_ROOT=/tmp/whispering-demo bun dev:whispering

# A release bundle: apps/whispering/src-tauri/target/release/bundle
bun build:whispering

# The page alone in a browser tab, over a folder kept in IndexedDB
bun dev:whispering:ui
```

`bun dev:whispering` runs `tauri dev`. There is no hot reload: the page is built
once and served by Whispering's host process. Use `bun dev:whispering:ui` for a
fast UI loop.

The desktop app has three parts. The window's shell owns the data folder and
is the only thing that saves to it or records its history. A host process
serves the page, runs the terminal, and sends transcription and transformation
requests. The page is the UI. The host cannot be run on its own: only the
shell starts it, with the folder it chose.

Checks, from `apps/whispering`:

```sh
bun run typecheck                 # the page, then the host
bun test --isolate                # host, workspace, publication, and workflow tests
bun run build                     # the page, into build/
bun run build:sidecar             # the compiled host, for the desktop bundle
cargo test --manifest-path src-tauri/Cargo.toml   # the shell: folder registration and window grant
```

### Environment

| Variable | Meaning |
| --- | --- |
| `WHISPERING_DATA_ROOT` | The data folder. Default `~/Epicenter/local/so.epicenter.whispering`. Created when absent. |
| `WHISPERING_TRANSCRIPTION_BASE_URL`, `WHISPERING_TRANSCRIPTION_MODEL` | Written to `kv.json` the first time a folder is opened. After that, `kv.json` decides. |
| `WHISPERING_TRANSCRIPTION_API_KEY` | The API key for this launch, used for transcription and for transformations. Overrides the key saved from Settings. |
| `WHISPERING_AUDIO_FIXTURE` | Debug builds only. A file whose bytes answer every recording. See [Fixture audio](#fixture-audio). |
| `WHISPERING_BUN` | Debug builds only. The Bun executable that runs the host, when `bun` is not on `PATH`. |

## Using it

Whispering has three pages. The sidebar switches between them on a wide window
(click the microphone, or press Ctrl+B or Command-B, to expand it), and a bar
at the bottom does on a narrow one. Each page has its own address, so back,
forward, and refresh work.

| Page | Address | What it is for |
| --- | --- | --- |
| Home | `/` | The recorder, and the newest recording with its transcript. |
| Recordings | `/recordings` | Every saved recording: filter, play, rename, transcribe, transform, write notes, edit source. |
| Transformations | `/transformations` | The prompts you apply to transcripts, and the results they produced. |

Changing pages keeps everything in progress: a recording keeps recording, a
request keeps running, unsaved typing stays in its editor, and the terminal
keeps its output, history, and directory. One folder is opened when the app
starts and it stays open until the app closes.

The header is the same on every page: the status line, a recorder control,
Settings, Reveal folder, Files, and Terminal. Directly under it, also on every
page, is anything that is not saved yet.

| Control | What it does |
| --- | --- |
| Start recording / Stop recording | On Home. Records, then saves the audio and its row to `recordings/`. On other pages the header has a microphone button to start, and while a recording runs it shows the elapsed time and Stop. |
| Transcribe | Sends the saved audio to the endpoint in Settings and saves the answer as a row in `transcriptions/`. Nothing is transcribed until you press it. |
| A recording | Details: play the audio, change the title, transcribe, transform a transcript, write notes. Source: the row's Markdown. Both edit one draft. |
| Filter | On Recordings. Matches the title, notes, ID, and transcripts. A recording that needs repair is always listed. |
| Transform | On a transcript. Applies one of your transformations and saves the answer as a new file under the transcript. |
| Status | Saved files, uncommitted changes, the last commit attempt, and the folder path as separate lines, with Check again and Commit now. |
| Settings | Transcription endpoint and model (saved in `kv.json`) and the API key (kept on this device, outside history). |
| Reveal folder | Opens the data folder in Finder. |
| Files (Ctrl+Shift+E) | The folder's files, beside any page. A recording row opens on Recordings and a transformation on Transformations; an audio file opens a player and other text a plain editor, both on Recordings. |
| Terminal (Ctrl+\`) | Commands in the data folder, under any page. Its output, history, typed command, and directory stay when it is hidden. |

### Transformations

A transformation is a prompt you reuse: clean up dictation, summarize, draft an
email. It is one Markdown file in `transformations/` with a title, a model, and
an endpoint in its frontmatter and the prompt as its body.

- **New** creates one. It offers three starters (Clean up, Summarize, Draft an
  email) and an empty one. Nothing is created until you choose; the app never
  adds files on its own.
- Edit the title, prompt, endpoint, and model in Details, or the whole file in
  Source. Edits save like any other file here, with the same conflict handling.
  Fields the app does not know are kept as written.
- The endpoint is an OpenAI-compatible base URL and the model is whatever that
  endpoint calls it. Whispering keeps no list of providers or models. A new
  transformation copies the endpoint and model of one you already have; the
  first one starts with the transcription endpoint and no model.
- Run one from a transcript's **Transform** menu on Recordings, or from the
  transformation's own page by choosing a transcript and pressing **Run**.

Running sends one request: `POST <endpoint>/chat/completions` with the model,
the prompt as the system message, and the transcript as the user message. The
answer is saved as a new file in `transformation_runs/`. The transcript's own
file is never written, so the original text is always there.

Each result file records the recording, transcription, and transformation it
came from, when, the model and endpoint, and the exact prompt and transcript
text that were sent. A result therefore still reads correctly after you edit or
delete its transformation. Deleting a transformation keeps its results.
Deleting a recording deletes its file, its transcripts, and the results made
from them. Its audio file is kept, and the confirmation says so; delete it
from Files when you no longer want it. A recording cannot be deleted while a transcription or transformation of it is
running, or while an answer for it is waiting to be saved: finish it, save it
again, or discard it in the notice under the header first.

What is sent is always what the folder holds when you press the button. If the
transcript's file was edited in Files, the terminal, or another program, the
edited text is sent; if it or its recording is gone, or the file cannot be
read, nothing is sent and the app says why.

**The key.** Transformations use the same API key as transcription, the one in
Settings. There is one key per device, sent to whichever endpoint a
transformation names, so point transformations only at endpoints you would give
that key to. In the desktop app the host process sends the request and the key
never reaches the window, the folder, or history. In a browser tab
(`bun dev:whispering:ui`) the tab sends the request itself, so the endpoint
must allow the page's origin (CORS). Most hosted providers refuse that; a local
endpoint or the desktop app works.

When a request fails, the notice under the header says why and offers **Try
again**, which sends the same request. When the answer arrives but its file
cannot be written, the text is kept in the window with **Save it again**, which
writes the same file and does not call the endpoint a second time.

One failure is different. If the desktop app's host process stops answering
partway, the window cannot tell whether the request reached the endpoint: it
may have been sent, and even answered, with the reply lost on the way back. The
notice says the outcome is not known, not that nothing was sent. Whispering
never sends it again on its own; **Try again** is one more request, and with a
paid endpoint possibly one more charge. This applies to transcription too.

### Saved is not committed

A save writes files. A commit records them in history. They are separate
outcomes and the status reports them separately.

- Every content save through tables, KV, or Files tries one commit
  automatically. Typing saves after a short pause.
- In the desktop app that try happens only if the folder is free at that
  moment. A save that lands while another save or commit is running is saved
  and not committed; nothing retries it later. The next save's commit, or
  **Commit now**, includes it.
- A commit that fails or is blocked never undoes a save and never reports the
  save as failed. The status says "Saved" and what happened to the commit, and
  **Commit now** tries again.
- Quitting commits nothing. Saves that are underway finish, and whatever was
  saved and not yet committed stays that way until the next commit.
- The browser terminal follows the folder's automatic history policy and refuses
  `git add` and `git commit` in automatic mode. Staged authoring requires a folder
  opened with `commitOnEdit: false`.
- Desktop terminal commands and other programs edit disk directly. Their changes
  enter the next automatic checkpoint or an explicit commit.

### When a save does not finish

Captured audio stays in the window until the folder is known to have both files. If writing
stops partway (the audio is saved and its row is not), the recording appears in
the notice under the header, on every page, with what happened, a player for
the audio held in the window, and **Try again**. Trying again keeps the
recording's ID and cannot create a second recording. It first reads what the
folder has. If the audio there is exactly the audio held in the window, it
saves the recording's file beside it, and only if that audio has not changed
in the meantime. If a different file is at the recording's audio path or its
own path, even audio of the same length, nothing is overwritten and the
recording stays pending. A file that only shares the recording's name with
another extension is not in the way.

Sometimes a recording is saved and then cannot be shown: the folder confirmed
both files were written, and reading the recording's file straight afterward
failed, or another program removed or replaced that file in between. That is
not a failed save, and the app does not call it one. The status reads "Saved ·
1 recording to check" and the notice says the recording was saved, with
**Refresh** and **Dismiss**:

- **Refresh** reads the folder again and writes nothing. When the file reads
  as this recording, including after you have changed its title or notes, the
  notice goes away and the recording opens.
- If the file is gone or is no longer this recording, the app leaves it as it
  is. It does not write the recording a second time. Restore the file
  yourself, for example from Git history, if you want it back.
- **Dismiss** drops the notice and the copy of the audio held in the window.
  Nothing in the folder changes.

This notice does not keep the app from closing, since nothing is unsaved.

A transcript or a transformation result whose file could not be written is kept
the same way: the status says it is not saved, and the notice shows the text
with **Save it again** and **Copy**. A transformation result keeps the file name
it was given when the run began, so saving again cannot produce a second result,
and if another file has taken that name it is left alone.

Pending audio, an unsaved transcript or result, and unsaved typing live only in
the open window. They are not written anywhere else.

### Closing and quitting

Closing the window (the close button or Command-W) and quitting (Command-Q or
the Whispering menu) both ask the window first:

- When nothing is held, typing that can still be saved is saved and the app
  closes with no prompt.
- When something is held (a recording in progress, a recording that is not in
  the folder, a transcript or transformation result whose file was not written,
  a running transcription or transformation, or edits that cannot be saved),
  the app stays open and shows what would be lost. **Keep working** closes the
  prompt and changes nothing. **Discard and quit** closes the app and drops
  what was held.

Only leaving the app asks. Moving between Home, Recordings, and
Transformations never does, because nothing is lost by it.

The app closes only on an explicit answer from the window. A window that is
busy or slow keeps the app open until it answers; closing again only asks
again.

If Whispering's host process stops while the window is open, the terminal,
Reveal folder, and new transcription and transformation requests stop working
until you restart the app. Saving does not stop: the folder belongs to the
window's shell, so changes to recordings, transcripts, and other files can
still be saved, a pending recording can still be tried again, and **Commit
now** still works. A save can still fail for its own reasons, such as a full
disk, exactly as it can at any other time.

What the window can no longer do is be asked through the host whether it may
close. Closing or quitting then shows a prompt that says so and lists what is
still only in the window. The list follows what you save, and **Keep working**
lets you save, play a pending recording, or copy text out first. The app stays
open until you choose **Discard and quit** (or **Quit** when nothing is held);
in this state it never closes without that choice.

If the folder could not be opened at all and the window shows "Could not open
the recordings folder", nothing is open and nothing can be unsaved, so closing
or quitting just closes it.

This covers an ordinary close or quit. It does not cover the process being
ended from outside: Force Quit, `kill`, a crash, or power loss discard whatever
was only in the window, and nothing can recover it afterwards. Force Quit is
also the only way out if the window itself stops responding, or is closed
while it is still opening the folder and never finishes, since a window that
cannot answer is never closed on its behalf.

In a browser tab (`bun dev:whispering:ui`) the browser's own leave warning
applies instead.

### Changes from outside

The app notices changes to the folder from any program, usually at once and
otherwise within a couple of seconds.

- An editor with no unsaved typing shows the new content.
- An editor with unsaved typing keeps it, stops saving, and shows a conflict.
  **Show saved version** displays the file as it is now. Then choose: discard
  yours and load the saved file, save yours over it, or **Keep both**, which
  writes your text to `conflicts/<name>-<time>.md` and loads the saved file.

A recording or transformation row whose frontmatter cannot be read, or lacks a
field, stays in its list marked "Needs repair" with its file untouched. Fix it
in Source. A transformation that needs repair cannot run until it is fixed.
Fields the app does not know are kept as written.

### The terminal

On the desktop the terminal runs your own shell (`zsh`, `bash`, or `sh`) with
the data folder as its working directory, so `git log`, `git status`, `cat`,
`sed -i`, and redirection work on the real files.

It is not an interactive terminal. Each command runs in a new shell that starts
where the last one ended, so `cd recordings` holds but shell variables and
functions do not. There is no terminal device, so full-screen programs such as
`vim` or `less` exit at once; `git` output is not paged. A command that leaves
the data folder returns to its root. A command is stopped after two minutes.

Avoid making files executable in the data folder. History records plain files
only, so while an executable file is present a commit is not made, the branch
does not move, and the status reads "Commit blocked" with the reason. Saving
is not affected: your files are still written, and the status says so on its
own line. Remove the executable bit (`chmod -x <file>`) and commit again.

## Fixture audio

For repeatable automation, a debug build can answer every recording with the
bytes of one file:

```sh
WHISPERING_DATA_ROOT=/tmp/whispering-demo \
WHISPERING_AUDIO_FIXTURE=/path/to/tone.wav \
bun dev:whispering
```

The header shows a "Fixture audio" badge on every page and the recorder on Home
says the microphone is not used. Recordings made this way are saved with
`capture: fixture` and labelled on Home, in the list, and in details. A release
build refuses the variable, says so under the recorder, and records from the
microphone.

A fixture recording proves the save, playback, transcription, and history path.
It proves nothing about the microphone. Test the microphone separately.

## Failures you can cause on purpose

A debug build has a bug-icon menu in the header:

| Control | Effect |
| --- | --- |
| Pause autosave | Typing stays unsaved until "Save now", so an outside edit can be raced against a draft. |
| Fail the next recording file write | The next save lands the audio and fails the row: a partial publication. Each press arms one more. |
| Fail the next audio write | The next save of a new recording fails before anything is written. |
| Lock the branch | Creates a lock on the branch ref, where an interrupted Git process leaves one, so commits fail while saves succeed. Press again to unlock. It never replaces a lock that already exists and only ever removes the lock it created. |

Both publication failures are real: for the length of that one save, the host
puts an empty directory where the file would be written, so the folder itself
fails that step and reports it. The directory is removed afterward.

The same failures can be armed at launch with
`WHISPERING_DEBUG_FAIL_ROW_WRITES=<n>`, `WHISPERING_DEBUG_FAIL_AUDIO_WRITES=<n>`,
and `WHISPERING_DEBUG_BLOCK_COMMITS=1`. The branch lock is taken when the
window has opened the folder, since there is no branch before that. To cause the commit failure by hand in
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
- System-wide dictation: global shortcuts, push-to-talk, voice-activated
  recording, and delivering text to the cursor or clipboard automatically. Copy
  buttons are the only way text leaves the app.
- Automatic transcription or transformation after a recording. Each is a button
  you press, so nothing is sent to a paid endpoint on its own.
- On-device transcription models. Transcription needs an endpoint.
- Transformations beyond one prompt and one request: chained steps, find and
  replace rules, tools, running code, importing the earlier Whispering's
  transformations or recipes, a provider or model catalog, and a separate key
  per transformation or provider.
- A settings page. Settings is the one popover in the header.
- Importing audio files, choosing an input device, and recording overlays.
- Windows and Linux are untested. The terminal needs a POSIX shell.
- A release pipeline. `bun build:whispering` produces a locally signed bundle.
- Running inside the Epicenter desktop host. `bun run build:epicenter` still
  emits the page for that host, but the page opens nothing there. Epicenter
  does not start Whispering's host process and registers no Whispering
  folder, so the page shows "Could not open the recordings folder" and says
  that the desktop app did not start Whispering's host. Browser storage is
  never used inside a desktop app. The host's Whispering commands in
  `apps/epicenter/src-tauri` are not called by this app.
- Running the host process by hand, or opening the desktop folder from a
  browser tab. The folder belongs to the window's shell.
- Moving a recording's audio and having the recording follow. Nothing repairs
  `audioPath`, and nothing collects audio files that no recording names.
- Recordings saved by an earlier build of this app, whose files have no
  `audioPath`. They are listed as needing repair until the line is added.

The earlier Whispering stored recordings and transformations in a Yjs store.
Nothing reads that data. There is no migration. The pages, sidebar, and
recorder follow that app's layout; the code and the data underneath do not come
from it.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for how the pieces fit, and
[desktop verification](./docs/desktop-verification.md) for native acceptance
results, screenshots, the microphone hardware limit, and what has not been
checked in the desktop app since the pages and transformations were added.
