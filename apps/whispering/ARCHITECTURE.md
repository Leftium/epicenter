# Whispering architecture

Whispering is three parts. Each has one job, and exactly one of them owns the
data folder.

```text
src-tauri/        the shell     a window, the folder's owner, and one child process
native/           the host      serves the page and does what a page cannot
src/              the page      the UI; attaches to the folder, fetches the host
```

```text
┌───────────────── Tauri shell (Rust) ─────────────────┐
│ chooses the folder, registers it for the main window │
│ starts the host with that path, reads its port,      │
│ grants the page the owner's commands for that origin │
│ loads http://127.0.0.1:<port>/, injects the token    │
│                                                      │
│   tauri-plugin-epicenter-folder: the one owner       │
│   files, tables' bytes, history, lock, change hints  │
└────┬──────────────────▲────────────────┬─────────────┘
     │ spawns           │ invoke, events │ owns
     ▼                  │                ▼
┌── host (Bun) ─────┐  ┌┴─ page (WebView) ──┐   the data folder
│ page, terminal,   │◄─│ fetch /bridge/app  │   and its .git
│ requests, key,    │  │ Bearer <token>     │        ▲
│ close relay       │─►│ event stream       │        │
└─────────┬─────────┘  └────────────────────┘        │
          └── an ordinary program in that directory ─┘
```

The folder has one owner, the shared Rust plugin
(`tauri-plugin-epicenter-folder`), running in the shell's process. The page
attaches to it with `@epicenter/folder/tauri`, the shared desktop adapter, and
names only the folder's ID. This app has no folder code of its own on the
desktop: no copy of the plugin's bindings and no second transport.

The host does not open the folder. It is told the directory by the shell and
uses it as any other program would. The terminal runs the person's shell
there. Transcription reads one audio file out of it. The device key is a file
under its `.git`. Nothing in the host takes the folder's lock, initializes Git,
watches the directory, or saves a file the folder tracks.

This is not the end of the host. The page is still served by it, and the
terminal, revealing the folder, the provider requests, the key, fixture audio,
and the close relay still live there. A new native ability that is not the
folder is a host operation in `native/`, exposed through the workspace type
with a browser implementation or an explicit `undefined`.

The two fail apart. If the host stops while the app is open, the folder is
still open and still saves; what stops is what the host did.

## The data model

`src/lib/definition.ts` declares the folder with the shared vocabulary
(`@epicenter/definition`): four tables and `kv`. `@epicenter/folder` turns that
into Markdown rows at `<table>/<stem>.md` and `kv.json`. A table owns exactly
one Markdown file per row; any other file is an ordinary file reached through
`folder.files`. The package's [README](../../packages/folder/README.md) is the
contract for entries, captures, conditional saves, batches, source-preserving
patches, partial publication, and history.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's row; the title is a field.
- A recording names its audio in `audioPath`, a folder-relative path such as
  `recordings/<id>.wav`. That field is the only link between the two files.
  Nothing is inferred from a file that shares the row's stem. A row with no
  `audioPath`, including one written before the field existed, is listed as
  needing repair and has no audio the app will play or send; the app does not
  fill the field in. Deleting a recording deletes its row and keeps the audio,
  which is deleted from Files like any other file.
- A transcription is a separate row, so a recording can have several and each is
  a readable file.
- A transformation is a row in `transformations/`: title, model, and endpoint
  in frontmatter, the prompt as its body. Its results refer to it by stem, so
  the app never renames it either.
- A transformation result is a row in `transformation_runs/`. A table name is
  one bare identifier, which is why the folder is not `transformation-runs`.
  The row names its recording, transcription, and transformation, and carries
  the prompt and transcript text that were sent, so it can be read on its own
  after any of the three changes or is deleted. Nothing mirrors it elsewhere.
- The API key is not folder data. On the desktop it is in
  `<root>/.git/epicenter/whispering/device.json`, which Git never commits.
  Transcription and transformations use the same key.
- The chosen microphone is not folder data either: it names hardware on one
  device. It is a second field of the same `device.json`, never `kv.json`.
  `native/device-file.ts` owns that file. Each change starts from what the
  file holds, replaces only the field it names, and keeps every other field,
  including ones this build does not know. Changes run one at a time, so a
  key save and a microphone save that overlap both land.

Short file commands, including settings saves and file creation or deletion,
start independently. The library joins their completion promises. Quit
preparation awaits those accepted
commands and the editors' saves before deciding what remains unsaved. Recording
publication and provider work keep their own pending states and discard choices.

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. `openWorkspace()` picks an
implementation when the app layout mounts:

| | Desktop (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory, through the shell's owner (`openFolder` from `@epicenter/folder/tauri`) | A folder in IndexedDB (`openFolder` from `@epicenter/folder/browser`) |
| Terminal | Your shell in the directory, run by the host | The folder's own in-page shell (`folder.terminal()`) |
| Transcription | The host reads the audio and makes the request | The page makes the request |
| Transformation | The host makes the request | The page makes the request, so the endpoint must allow its origin (CORS) |
| Key | A file under `.git` | `localStorage` |
| Chosen microphone | The same file under `.git`. The page's own storage does not last, since the host serves it from a new port each launch | `localStorage` |
| Outside changes | The owner's hints: any program, this app included | Other tabs' saves, as hints to read again |
| Reveal, failure injection | Yes | No |

`isTauri()` selects the storage: inside a desktop app the folder is the
shell's, and in a browser tab it is the browser's. There is no build flag, and
the host's token is not the test. The desktop workspace needs two things, and
each is opened or refused on its own terms:

1. The host. The standalone shell injects `window.__WHISPERING_BRIDGE__`
   before the page runs. A desktop app that injected none did not start
   Whispering's host, and the page refuses with `HostMissing` before it asks
   anyone for a folder. A host that does not answer is `HostUnreachable`.
2. The folder. `openFolder({ definition })` attaches to the scope
   `so.epicenter.whispering`. The owner's refusal (an unknown scope, a window
   the scope does not list, a folder another process holds, a missing
   permission, another protocol version) is `DesktopFolder`, with the owner's
   own reason.

The page then checks that the owner and the host name the same directory and
refuses with `FolderMismatch` if they do not, since the terminal and
transcription would otherwise use a directory the saves do not go to.

Everything above the seam (`library.svelte.ts`, the editors, the components)
is the same code for both. Opening returns a `Result`, and a refusal is shown
on the "Could not open the recordings folder" screen as it is. The two
storages are never substitutes: nothing that is missing or refuses inside a
desktop app is replaced by browser storage, and the browser opener itself
refuses there (`InsideTauri`).

Page code names types and helpers from `@epicenter/folder`. `vite.config.ts`
aliases that exact specifier to `@epicenter/folder/browser`. The desktop
workspace imports `@epicenter/folder/tauri` by its own name, which the alias
leaves alone, and the opener loads that workspace with a dynamic import, so a
browser tab never loads the desktop adapter. `src/lib/page-boundary.test.ts`
fails if anything else under `src/` opens a folder, imports a Node or Bun
module, imports a Tauri module other than the opener's `isTauri`, or imports
the Yjs store.

## The shell, the folder, and the window

The shell settles four things, in this order, before the window exists
(`start` in `src-tauri/src/lib.rs`):

1. **Where the folder is.** `WHISPERING_DATA_ROOT`, or
   `~/Epicenter/local/so.epicenter.whispering`. The shell creates it when
   absent and resolves it once. That resolved path is the only spelling used
   afterward.
2. **The host.** It is started with that path in its environment and reports
   only its port. A path on its ready line would not be read.
3. **The registration.** The scope `so.epicenter.whispering` is registered
   with that path for the window labelled `main`, with the author
   `Whispering <whispering@localhost>` and no remote. The repository's own
   `user.name` and `origin` are not read, so a save never pushes.
4. **The capability.** The page is served from `http://127.0.0.1:<port>`,
   which Tauri treats as a remote origin with no commands at all. One
   capability, added at runtime because the port is not known until then,
   grants the `main` window, on exactly `http://127.0.0.1:<port>/*`, the
   owner's commands (`epicenter-folder:default`) and listening for its events
   (`core:event:allow-listen`, `core:event:allow-unlisten`). `tauri.conf.json`
   lists no capability.

So the page cannot choose a directory: it names a scope, and the shell decided
what that scope is. Another window, a page from another origin or port, and a
local page are each outside the capability, and a window other than `main`
would be refused by the registration even with one.

If any of the four fails, the host is stopped and nothing is granted. The
window that opens is the local failure page, which can call no command and
reach no folder.

## The session and the pages

```text
routes/+layout.svelte      opens one session on mount, closes it on destroy
└── AppShell               sets the session in context; header, navigation,
    │                      unsaved notices, Files, Terminal, close prompt
    ├── /                  +page.svelte            recorder and latest recording
    ├── /recordings        recordings/+page.svelte list, details, raw files
    └── /transformations   transformations/+page.svelte
```

`src/lib/session.svelte.ts` is the owner. A session is the workspace, the
product state over it (`library.svelte.ts`), the close guard, and what the
shell is showing. The layout holds one opening (`mountSession`) and nothing
else does: pages call `getSession()` and never open a workspace. There is no
module-level store, so a session exists only while a layout holds it, and
releasing the layout releases the folder. `src/lib/page-boundary.test.ts` reads
the sources and fails if anything but the layout holds an opening.

A session exists only once it has started: the folder was read, the settings
file exists, and the close guard is listening. An opening that fails leaves no
session. The same holder then answers the shell's close question, so the
window showing the refusal can be closed; see "Closing".

Because the pages are routes under that one layout, a page change is a
re-render inside the same session. The live recording, pending captures,
selections, running requests, drafts, and the terminal session are fields of
the library, not of any page, so none of them is touched by navigation. What a
page keeps in its own component (which tab is showing) is the only thing a page
change resets.

Leaving is guarded in one place, the shell. `beforeNavigate` holds a navigation
only when it unloads the document and something is held; a navigation between
routes is never held. The desktop close handshake below is answered by the
session's guard, above the routes, for the same reason.

The host serves `index.html` for any path that is not a file, so
`/recordings` and `/transformations` open directly and survive a refresh.

## The bridge

The bridge is the page's link to the host. It carries Whispering's own
operations and the close question, and nothing of the folder: there is no
folder route, no generic method call, no batch sent as data, and no Git
snapshot pushed over it. Tables, KV, conditional publication, `folder.batch`,
and history are the shared adapter's calls to the shell's owner.

```text
POST /bridge/app      { op, payload }   -> { ok: <value> } | { fault: "<message>" }
GET  /bridge/events   newline-delimited JSON: "close-requested" and pings
```

`src/lib/bridge/http.ts` is the page's end and `native/host.ts` the host's.
`src/lib/bridge/codec.ts` encodes what JSON cannot carry (`undefined`, bytes,
maps, errors), so fixture audio arrives as bytes and a transcription `Result`
arrives with its error intact. It is still a wire encoding this app owns.

Every bridge request must carry the per-launch token. The host also refuses a
request whose `Host` or `Origin` is not its own loopback address. The page is
served with a content security policy that allows connections to the host and
to the shell's own commands (`ipc:`), and to nothing else.

`/bridge/app` operations: `info`, `terminal`, `reveal`, `transcribe`,
`transform`, `credential`, `preferences`, `set-preferences`, `close`, and, in a
debug shell only, `fixture`, `inject`, `injection`, `injection-launch`,
`obstruct`, and `unobstruct`. `transcribe` and `transform` take what to send
and return a `Result`; the host adds the key and never returns it.
`preferences` and `set-preferences` read and save the chosen microphone. Their
replies are built from that field alone, so the key beside it is never in one,
and saving a microphone works while the key comes from the environment.

A bridge call that fails says only that no reply arrived. The host may never
have been reached, or it may have called the endpoint and had its reply lost.
The page reports that as `HostUnavailable`, worded as an unknown outcome and
never as "not sent", and does not make the call again; trying again is the
person's choice and is one more request. `AudioUnreadable` is the opposite,
certain case: it is the host's own answer that the file was not read and no
request was made.

### Reading audio for transcription

`transcribe` is given the folder-relative path a recording's row names, the
endpoint, and the model. The page sends no audio. The host reads the file
itself (`native/audio.ts`), once, and sends those bytes with the file's own
name and the type its extension calls for.

The read is literal and narrow:

- The path must pass the folder's own path rule: folder-relative, no `.` or
  `..`, no empty segment, no backslash or control character, nothing under
  `.git`.
- Every component must appear in its directory under exactly that spelling, so
  a case-insensitive disk cannot alias another name.
- No component may be a symbolic link, whether it points inside the folder or
  out of it. Every component before the last must be a directory and the last
  a regular file.
- The file is opened once, without following a link and without blocking,
  checked again through the open handle, read into bytes the host owns, and
  closed.

Anything else is `AudioUnreadable` and no request is sent.

What is sent is what the path held when it was read. No version is asked for
or checked: the row gives a path, not a capture, exactly as before this read
moved out of the folder. A change to the file after the read does not change
the request.

This is best effort against a program writing the folder at the same moment.
Each component is checked and then used in separate steps, so a writer that
replaces a directory on the way with a link, between its check and the open,
is followed. Opening without following a link protects the last component
only.

## Recording and publication

There are two capture devices. The microphone device (`src/lib/microphone.ts`)
uses the WebView's `MediaRecorder`. The fixture device (`src/lib/capture.ts`)
returns fixed bytes and marks them `fixture`. A workspace has exactly one,
chosen when it opens; neither falls back to the other. The saved extension
comes from the container signature in the bytes (`src/lib/audio-format.ts`),
and from the recorder's claimed MIME type only when the signature is not
recognized.

### The microphone

The microphone device also has `inputs`: listing, asking for access, and a
level reading. The fixture device has none, so in fixture mode nothing lists,
asks for, or opens a microphone.

- A chosen microphone is asked for as `{ deviceId: { exact } }`. A WebView
  that cannot open exactly that one answers with a refusal
  (`InputUnavailable`), and a stream that reports another device is released
  and refused. The system default is asked for only when nothing is chosen.
- Listing is `enumerateDevices` and nothing else. It never asks for access, so
  before access is allowed it names no input. `allow` is the separate action:
  it opens the default microphone and releases it at once.
- Every request takes an `AbortSignal`. A stream that arrives after its
  request was withdrawn is released there, so a late answer leaves nothing
  open.

`src/lib/microphone-input.svelte.ts` is the session's state over that, a field
of the library (`library.input`): the choice, the listing, and the one request
that may open a microphone outside a recording. Enabling and a test share that
one owner: at most one is under way, and `release` aborts it and stops its
meter. The popover's close, leaving Home, a new choice, `startRecording`, and
closing the library all call it, so nothing they leave behind holds a stream.
The recorder and that request never hold a microphone together.
`startRecording` releases before it asks for its own microphone and passes the
choice it read at that moment; the choice, a test, and `allow` are refused
while a recording is starting, running, or finishing. A recording cancelled or
closed while its microphone is opening aborts that request. Closing the
library releases the microphone first, before it waits for file commands it
had accepted, and stops listening for `devicechange`.

Nothing here runs at launch. The session reads the saved choice through
`workspace.preferences` and opens nothing; the first listing is when the
person opens the control.

The choice's identity is its device ID and nothing else. A name does not
identify a microphone: another one of the same model has the same name. So a
saved ID that is not listed is never matched to a listed input by name. The
choice stays as it is, the control shows it as not listed, and it changes only
when the person chooses again. A listing can be limited by permission, so
absence from it proves nothing about the microphone: a recording still asks
for exactly that ID, and refuses only if the WebView cannot open it. A WebView may give
the same microphone another ID in a new origin, and the desktop page's origin
changes with the host's port, so a choice may need choosing again after a
restart. That is a known limit, not yet checked on hardware.

`src/lib/recordings/publish.ts` publishes a capture and finishes one that
stopped partway. A capture is fixed when it ends: its ID, its bytes, and every
field of its row, including the `audioPath` its audio is saved at. Both files
are one `folder.batch`: the audio, then the row. A folder on disk applies those
as ordered steps, so a failure between them leaves audio with no row
(`Partial`), and a lost reply leaves the outcome unknown (`Unconfirmed`). The
capture stays in the page through both, and each attempt starts from what is
in the folder:

| The folder has | The attempt |
| --- | --- |
| Neither file | One batch: `files.create` the audio, then `tables.recordings.create` the row. |
| Exactly this capture's audio, and no row | One batch: `files.replace` the audio that was read with the same bytes, then create the row. |
| This capture's row and exactly its audio | Reports it saved and writes nothing. |
| Another row, other audio (same size or not), or the row without its audio | Refuses and writes nothing. |

The replacement in the second case writes bytes that are already there. Its
purpose is its condition: the batch lands only if the audio is still exactly
what was read, so a row is never created beside audio another writer changed in
between. Nothing is ever saved with `overwrite`, and the row's source always
comes from the table's own `create`.

Only the two paths the capture names are looked at. A file that merely shares
the stem, such as `recordings/<id>.m4a`, is not the recording's and does not
block it.

A complete batch receipt that names both writes, with the audio capture equal
to the pending bytes, proves the recording was published. It is not a reading
of the folder, and no entry or editor baseline is made from it. So after a
successful batch the row is read as a new observation, to have a current entry
to show. Publication and observation are separate facts:

| After a confirmed receipt, the row | Outcome |
| --- | --- |
| Reads as this recording | `saved`. The capture leaves the window's list and that entry is shown. |
| Cannot be read | `published`, problem `unreadable`. |
| Is gone | `published`, problem `missing`: another writer removed it after publication. |
| Is there and is not this recording | `published`, problem `foreign`: another writer changed it after publication. |

"This recording" is a valid row with the capture's `recordedAt`, `durationMs`,
`capture`, and `audioPath`. The title and notes are the person's to change and
are not compared, so an edited row is still this recording and becomes the
fresh baseline.

A `published` capture is saved. It keeps its fixed ID and bytes and the
receipt's two captures in `library.pending`, as state `published`, only so the
notice can be shown and the row looked at again. It is not counted as unsaved:
it does not hold the app open, and the status line reads "Saved · 1 recording
to check". **Refresh** calls `observePublication`, which reads the row and
nothing else. From a confirmed publication there is no path to another batch,
a file write, or a request: a missing or foreign row is left as found and the
notice says what the person can do.

`Partial`, `Unconfirmed`, a receipt that does not cover both files, and a
refusal before publication are not confirmed publications. They stay
unresolved, are reported as not saved, hold the app open, and **Try again**
starts from the table at the top of this section.

So a retry keeps the recording's identity, cannot create a second recording,
and never replaces a file it did not just read and recognize as its own. A
save is reported on its own; the commit it requests is a separate outcome.

## Transformations

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the transcript as the user
message, reading `choices[0].message.content`. It is plain `fetch`, shared by
the Bun host and the browser workspace like the transcription request. An error
never carries the key: an endpoint that echoes it has it removed.

`library.transform` applies a saved transformation to a saved transcript, both
named by path. Nothing is taken from a list entry, which may predate an edit or
a deletion made outside. It saves open edits to either file (and refuses if
they cannot be saved), then reads the transformation, the transcription row,
and the recording that row names. A missing, malformed, or empty transcript, or
a missing recording, refuses and nothing is sent. Then it fixes a run before
anything is sent: the result's stem, and every field the result row will hold,
including the prompt and transcript text. From there a run ends one of three
ways:

| The run | What is held | Trying again |
| --- | --- | --- |
| Saved | Nothing. The row is in `transformation_runs/`. | |
| Failed: the endpoint refused, was unreachable, answered wrongly, the transport threw, or the host's reply was lost | Nothing was received. The run is listed as failed. After a lost reply the endpoint may still have been called. | Only when the person asks. Sends the same request, under the same stem, only while the folder still has that transcript text and its recording. Otherwise it stays failed and says why. |
| Unsaved: the answer arrived and the row could not be written | The text, in the window. It blocks closing. | Writes the row. The endpoint is not called. |

Saving a run looks at the folder first, as recording publication does. No file
at the stem: the row is created exclusively. This run's own row already there
(an earlier write landed and its answer was lost): it is recognized and nothing
is written. Its own row means a valid row with the same body and every field
of the run's snapshot; fields the app does not declare are ignored. Any other
file there, including one that differs only in its prompt, model, endpoint,
transcript, or source, is not overwritten and the run stays unsaved. So one run
can produce at most one result file.

A transformation only ever creates rows in `transformation_runs/`. No code path
writes a transcription row from a transformation.

Deleting a recording deletes its row, its transcripts, and the results made
from them, and keeps its audio. It must not race the work that writes those
rows. `deletionFor` and `remove`
both refuse while a transcription or transformation of that recording is
running, or its answer is received and unsaved, and `remove` also refuses when
a result was saved after the person was asked. While `remove` runs, no request
starts for that recording. A failed run holds nothing; it is dropped with the
recording.

## Drafts and conflicts

`src/lib/editor.svelte.ts` holds one draft per open file: the text on screen
and the saved file its next conditional save is checked against. A recording's
Details and Source views read and write the same draft, and a transformation
is edited through the same row editor, so its conflicts, repairs, and unknown
fields behave identically.

A refresh hands each open draft the file as it is now. A clean draft adopts it.
A dirty draft keeps its text, stops saving, and holds both versions until the
person picks one, or keeps both by writing theirs to `conflicts/`. A save the
folder refuses as stale ends in the same state.

## Closing

Unsaved work lives only in the page, so the shell never decides to close on its
own. It holds back a window close and every exit request (Command-Q is a menu
item it owns, so that path cannot bypass it) and asks:

```text
shell   writes {"type":"close-requested"} to the host's standard input
host    sends a close-requested event to the page
page    saves what can be saved, then answers POST /bridge/app { op: "close" }
          proceed   nothing is held, or the person chose Discard and quit
          asking    it is showing its confirmation
          cancel    the person chose Keep working
host    prints {"closeApproved":true} when the answer is proceed
shell   exits; the owner settles the folder, and the host is stopped
```

`src/lib/leave.svelte.ts` is the page's side, over the workspace's `closing`
capability; a browser workspace has none and relies on the browser's leave
warning. The session creates the guard, so it answers from every page and
stops with the session. The page acknowledges every request with `asking` before it does
anything else, and treats a failure to find out what is held as holding
something.

Approval is never inferred. The host approves only on the page's authenticated
`proceed`. Whether the page's event stream is open, or ever was, says nothing
about what the page holds: a page can record and save while that stream has not
connected. So a request with no stream to carry it waits and is delivered when
one connects, and a page that does not answer keeps the window open. If the
page itself stops responding, Force Quit is the way out.

The desktop workspace owns that stream (`src/lib/workspace/desktop.ts`). It
opens one, reconnects when it drops, and hands a close question to whoever is
listening. A question that arrives before the session's guard is listening is
kept and delivered when it does; the host repeats an unanswered question to
every stream that connects.

A host that has stopped is not approval either, because the page still holds
its work. The shell then keeps the window and raises a `whispering:close-blocked`
event in the page, which shows the same confirmation. Choosing to quit
navigates to `/__whispering__/quit`; the shell refuses to load that address
and, only while the host is gone, exits on it. The shell exits with no answer
at all only when the app never started and the window is the failure page.
None of this adds a Tauri command: the question and the answer travel over the
host's standard streams and the authenticated bridge, and the host-gone
fallback uses a page event and a refused navigation.

With the host gone the folder is still open, since the shell owns it. Changes
to recordings, transcripts, and other files can still be saved, a pending
recording can still be tried again, and a commit can still be made. What is
gone is what the host did: the terminal, new transcription and transformation
requests, reveal, the key, and the relay of this question. The prompt says
exactly that and reads what is held live, so it shrinks as things are saved.
It promises nothing about any one save, which can fail for its own reasons
with or without the host. Quitting in this state is always the person's
explicit choice, even when nothing is held, because nothing can relay an
answer for them.

### While the session is starting

Opening is three steps: the workspace opens, the library reads the folder
once, and on a first launch it writes `kv.json`. That read and that write are
the session's own work in the folder, and a close must not be approved over
them. So the close guard is not created until all three have settled
(`createSession` in `src/lib/session.svelte.ts`): until then there is an
opening, not a session, and nothing answers the shell, not even `asking`.

A close asked in that time is not dropped. The host keeps an unanswered
request and repeats it to every stream that connects, and the desktop
workspace keeps one that arrives while nobody is listening, over the stream or
as the shell's host-gone event, and hands it to the first listener. When the
session has started, its guard receives the kept request and decides as it
would for any other: from a session that has finished starting.

If the start fails, the library and the workspace are closed first. Only a
completed close permits the answer described next to take over. If cleanup
also fails, the opening preserves both causes and approves no close. A layout
released while its session is still starting gets the same cleanup and no
answer at all.

One request is not carried across: a close attempted with the host already
gone, during a start that then fails. The shell raises that event once per
attempt and nothing repeats it, so the person closes again.

### When opening failed

The shell marks the page as opened when the window is built, before the page
has attached to anything. If the workspace then cannot be opened (the host
does not answer, the owner refuses the window, or the two name different
directories), or the session cannot start, there is no session and no guard,
and the shell would wait forever for an answer to a close.

So the holder of the opening answers instead (`mountSession` in
`src/lib/session.svelte.ts`, `answerCloseWithNothingOpen` in
`src/lib/workspace/closing.ts`). A returned refusal or an
`OpeningReleasedError` proves that nothing remains open. Only then is each
close the person asks for answered `proceed` through the host, or with the
quit address when the host is gone. A failed cleanup or an unexpected
rejection from the opener proves no such thing and installs no answer.

Whatever the failure, the failure page in Whispering's shell offers a Quit
button. Pressing it answers `proceed` through the host and, if the host does
not take it, navigates to the quit address as well; the page says when
neither was confirmed. It refuses while the opening is under way and after
the layout is released, and nothing listens for it. `closing.ts` reaches only
the bridge, so this works when the desktop workspace's own module is what
failed to load. A browser tab and a desktop app that injected no host token
offer no Quit.

It is narrow on purpose:

- It answers requests. It never closes anything unasked and has no timer.
- It does not run while an opening is under way, which includes the session's
  first read and settings write. A close asked then waits: for the session's
  guard if the opening succeeds, for this answer if it fails, and in that case
  only after everything the opening had opened was closed.
- It does not run while a session exists, and it is stopped when the layout
  is released, so it can never answer for a session that holds work.
- It uses the same authenticated `close` operation and the same quit address
  as the guard. The shell gained no command and no privilege for it.
- A desktop app that injected no host token is not Whispering's shell and
  asks no close question, and a browser tab has the browser's own; neither is
  answered.

When the shell exits, the owner refuses new work, lets the saves and commits
it had already admitted finish, and releases the folder. It commits nothing of
its own, so a save whose automatic commit attempt was skipped stays saved and
uncommitted. Closing the page's folder handle only detaches the window.

## History

The shell registers the folder with automatic commits on and no remote. A
complete content save makes one automatic commit attempt and does not wait for
it. The owner makes that attempt only if the folder is free at that moment; a
skipped attempt is not retried by a timer and is not owed later, so the save
stays uncommitted until a later save's attempt or **Commit now** includes it.
`src/lib/status.ts` turns the folder's Git snapshot into separate lines for
saved files, uncommitted changes, and the last commit attempt, and never lets
a commit outcome change what it says about a save.

## The terminal

`native/terminal.ts` runs one shell process per command in the data folder. The
shell prints its final directory behind a marker that is new for each run; the
host cuts that tail off and carries the directory to the next command. There is
no terminal device, so nothing interactive runs. `src/lib/terminal.svelte.ts`
keeps the session (output, history, typed command) for the life of the window,
so hiding the terminal loses nothing.

It is the person's real shell, not the folder's in-page one, and it writes the
directory as any other program does, outside the owner. Nothing it writes is
committed until a save or an explicit commit includes it, and a draft whose
file it changed conflicts on its next save like any other outside edit.

## Noticing outside changes

The owner watches the directory and tells every attached window which paths
changed, its own saves included. The desktop workspace passes that on as
`onExternalChange`, and the page rereads its lists, open files, and Git status.
The host watches nothing and says nothing about files.

## Debug builds

The shell sets `WHISPERING_DEBUG=1` for the host when it is compiled with debug
assertions and removes it otherwise, whatever the environment says. Only then
does the host accept `WHISPERING_AUDIO_FIXTURE` and construct
`native/failure-injection.ts`.

Injected publication failures are counted, so a test can order failure and
retry exactly. They are real failures of the real batch, and the folder's own
`batch` is still the only thing that publishes. `publishRecording` takes an
optional hook that runs its one batch; in a debug shell the workspace supplies
one that asks the host to `obstruct` first and to `unobstruct` afterward. The
host puts an empty directory at the path of the step that should fail, the
owner runs the batch, and the host removes the directory. The owner then
reports its own `Partial` (row obstructed, audio saved) or its own refusal
(audio obstructed, nothing saved). Only a recording's row path and the audio
path its batch creates can be obstructed; both are checked before they are
joined onto the root, and a path that is occupied or passes through a link is
left alone. A host that cannot be asked places nothing, and the recording is
published all the same.

The injected commit failure is a real lock file on the ref of the branch `HEAD`
names, created exclusively and tagged with a marker unique to that host. The
host removes only a lock carrying its own marker, so it never takes or clears a
lock another Git process holds. Because the host does not initialize Git, the
lock can only be taken once the owner has opened the folder: a lock asked for
at launch (`WHISPERING_DEBUG_BLOCK_COMMITS=1`) waits until the page has
attached and says so (`injection-launch`).

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert folder declaration. |
| `src/lib/workspace/` | The storage seam and its two implementations. |
| `src/lib/bridge/` | The page's link to the host: its wire encoding and the HTTP calls. Nothing of the folder. |
| `src/lib/session.svelte.ts` | The one session a mounted layout owns, and its context. It holds what the shell shows, the post-processing choice, and the settings draft. |
| `src/lib/settings-draft.svelte.ts` | The one draft of the transcription settings, shown by the header's Settings and by the control on Home. |
| `src/lib/post-processing.ts` | What the post-processing choice is now, read against the listed transformations. It runs nothing. |
| `src/lib/library.svelte.ts` | Product state: lists, selections, retained editors, pending captures, transcription and transformation runs, settings. |
| `src/lib/recordings/publish.ts` | Publication and recovery. |
| `src/lib/capture.ts`, `microphone.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | The capture contract and fixture device, the real microphone, container detection, the transcription and transformation requests. |
| `src/lib/microphone-input.svelte.ts` | The chosen microphone and the test of it, for one session. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/editor.svelte.ts`, `status.ts`, `files.ts`, `terminal.svelte.ts` | Drafts, status lines, the file tree, the terminal session. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, unsaved notices, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `native/` | The host: `main.ts`, `host.ts`, `audio.ts`, `device-file.ts`, `terminal.ts`, `failure-injection.ts`. |
| `src-tauri/` | The shell: the window, the folder's registration and capability, and the host's lifetime. `shell/index.html` is shown only when the app cannot start. |
| [scripts/build-sidecar.ts](./scripts/build-sidecar.ts) | Compiles the host for the bundle. |
| `src/lib/tauri/bindings.gen.ts` | Generated by the Epicenter host's build for its own tests. Nothing here imports it. |
