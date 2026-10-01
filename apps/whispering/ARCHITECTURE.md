# Whispering architecture

Whispering is three parts. Each has one job, and only one of them touches the
data folder.

```text
src-tauri/        the shell     a window and one child process
native/           the host      opens the folder, serves the page, answers its calls
src/              the page      the UI; plain fetch, no native module
```

```text
┌──────────── Tauri shell (Rust) ────────────┐
│ starts the host, reads its port,           │
│ loads http://127.0.0.1:<port>/, injects    │
│ the launch token, stops the host on exit   │
└───────┬───────────────────────┬────────────┘
        │ spawns                │ window
        ▼                       ▼
┌── folder host (Bun) ──┐   ┌── page (WebView) ──┐
│ openNativeFolder      │◄──│ fetch /bridge/*    │
│ tables, kv, history   │   │ Bearer <token>     │
│ shell, watch, HTTP    │──►│ event stream       │
└──────────┬────────────┘   └────────────────────┘
           ▼
   the data folder and its .git
```

The page calls no Tauri command, so the Rust crate registers none and the window
has no capabilities. Everything native is in the host, which is ordinary
TypeScript that tests run directly.

## The data model

`src/lib/definition.ts` declares the folder with `defineStore`: four tables and
`kv`. `@epicenter/app/files` turns that into Markdown rows at
`<table>/<stem>.md`, a same-stem attachment per row, and `kv.json`. The package's
[README](../../packages/app/README.md) is the contract for entries, conditional
writes, source-preserving patches, partial publication, and history.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's files; the title is a field.
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

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. `openWorkspace()` picks an
implementation when the app layout mounts:

| | Desktop (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory, through the bridge | A logical folder in IndexedDB (`openBrowserFolder`) |
| Terminal | Your shell in the directory | The in-page shell from `@epicenter/app/files/terminal` |
| Transcription | The host makes the request | The page makes the request |
| Transformation | The host makes the request | The page makes the request, so the endpoint must allow its origin (CORS) |
| Key | A file under `.git` | `localStorage` |
| Outside changes | Watched and announced | None exist |
| Reveal, failure injection | Yes | No |

The desktop shell injects `window.__WHISPERING_BRIDGE__` before the page runs.
Its presence selects the desktop workspace; there is no build flag. Everything
above the seam (`library.svelte.ts`, the editors, the components) is the same
code for both. `src/lib/page-boundary.test.ts` fails if anything under `src/`
imports a Node, Bun, or Tauri module, the native folder opener, or the Yjs
store.

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
shell is showing. The layout opens one and nothing else does: pages call
`getSession()` and never open a workspace. There is no module-level store, so
a session exists only while a layout holds it, and closing the layout releases
the folder. `src/lib/page-boundary.test.ts` reads the sources and fails if
anything but the layout opens a session.

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

The host proxies the `Folder` API, not the file boundary beneath it: every
folder method takes data and returns a `Result`, so a call is its method path
and arguments, and the answer is the folder's own answer. Tables, KV,
conditional publication, and the history coordinator run in the host, beside the
files. The page holds no copy of the data. Its only bridge state is the latest
Git snapshot, pushed by the host so `git.snapshot` stays synchronous.

```text
POST /bridge/call     { path: ["tables","recordings","create"], args: [...] }
                      -> { ok: <value> } | { fault: "<message>" }
GET  /bridge/events   newline-delimited JSON: git snapshots, "files" changed, pings
POST /bridge/app      { op, payload }   Whispering's own operations
```

`src/lib/bridge/codec.ts` encodes what JSON cannot carry (`undefined`, bytes,
maps, errors) so an entry's `issues: undefined` and a `Partial` error arrive
intact. `src/lib/bridge/folder-client.ts` and `native/folder-rpc.ts` are the two
ends and contain nothing specific to Whispering. [bridge proposal](./docs/bridge-proposal.txt) is
the contract as proposed to the other file-folder apps.

Every bridge request must carry the per-launch token. The host also refuses a
request whose `Host` or `Origin` is not its own loopback address. The page is
served with a content security policy that allows connections only to the host.

`/bridge/app` operations: `info`, `terminal`, `reveal`, `transcribe`,
`transform`, `credential`, `close`, and, in a debug shell only, `fixture`,
`inject`, and `injection`. `transcribe` and `transform` take what to send and
return a `Result`; the host adds the key and never returns it.

## Recording and publication

`src/lib/capture.ts` has two devices. The microphone device uses the WebView's
`MediaRecorder`. The fixture device returns fixed bytes and marks them
`fixture`. A workspace has exactly one, chosen when it opens; neither falls back
to the other. The saved extension comes from the container signature in the
bytes (`src/lib/audio-format.ts`), and from the recorder's claimed MIME type
only when the signature is not recognized.

`src/lib/recordings/publish.ts` publishes a capture and recovers one that
stopped partway. A native folder writes the audio and then the row as two
filesystem steps, so a failure between them leaves audio with no row. The
capture keeps its ID and bytes in the page, and each attempt starts from what is
in the folder:

| The folder has | The attempt |
| --- | --- |
| Neither file | Publishes both through the table. |
| This capture's audio, byte for byte, and no row | Writes only the row, as an exclusive creation, then asks for a commit. |
| This capture's row and audio | Reports it saved and writes nothing. |
| Anything else at those paths | Refuses and writes nothing. |

So a retry keeps the recording's identity, cannot create a second recording, and
never replaces a file it cannot show it wrote.

## Transformations

`src/lib/transformation.ts` is the request: `POST <base>/chat/completions` with
the model, the prompt as the system message, and the transcript as the user
message, reading `choices[0].message.content`. It is plain `fetch`, shared by
the host and the browser workspace like the transcription request. An error
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
| Failed: the endpoint refused, was unreachable, answered wrongly, or the transport threw | Nothing was received. The run is listed as failed. | Sends the same request, under the same stem, only while the folder still has that transcript text and its recording. Otherwise it stays failed and says why. |
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

Deleting a recording deletes its transcripts and the results made from them,
so it must not race the work that writes those rows. `deletionFor` and `remove`
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
shell   exits, then stops the host
```

`src/lib/leave.svelte.ts` is the page's side, over the workspace's `closing`
capability; a browser workspace has none and relies on the browser's leave
warning. The session creates the guard, so it answers from every page and
stops with the session. The page acknowledges every request with `asking` before it does
anything else, and treats a failure to find out what is held as holding
something.

Approval is never inferred. The host approves only on the page's authenticated
`proceed`. Whether the page's event stream is open, or ever was, says nothing
about what the page holds: a page can record and edit while that stream has not
connected. So a request with no stream to carry it waits and is delivered when
one connects, and a page that does not answer keeps the window open. If the
page itself stops responding, Force Quit is the way out.

A host that has stopped is not approval either, because the page still holds
its work. The shell then keeps the window and raises a `whispering:close-blocked`
event in the page, which shows the same confirmation and says nothing more can
be saved. Choosing to quit navigates to `/__whispering__/quit`; the shell
refuses to load that address and, only while the host is gone, exits on it. The
shell exits with no answer at all only when the host never started and the
window is the failure page. None of this adds a Tauri command: the question and
the answer travel over the host's standard streams and the authenticated
bridge, and the host-gone fallback uses a page event and a refused navigation.

## History

The host opens the folder with automatic commits on and no remote. Every content
save through tables, KV, or files requests a commit and does not wait for it. `src/lib/status.ts` turns the
folder's Git snapshot into separate lines for saved files, uncommitted changes,
and the last commit attempt, and never lets a commit outcome change what it says
about a save.

## The terminal

`native/terminal.ts` runs one shell process per command in the data folder. The
shell prints its final directory behind a marker that is new for each run; the
host cuts that tail off and carries the directory to the next command. There is
no terminal device, so nothing interactive runs. `src/lib/terminal.svelte.ts`
keeps the session (output, history, typed command) for the life of the window,
so hiding the terminal loses nothing.

## Noticing outside changes

`native/watch.ts` compares a signature of the folder: every file's name, size,
and modification time outside `.git`, plus where the branches point. A recursive
filesystem watch triggers a comparison at once and a one-second poll runs it
regardless, because a platform watch can miss events silently. One change is one
`files` event; the page then rereads its lists, open files, and Git status.

## Debug builds

The shell sets `WHISPERING_DEBUG=1` for the host when it is compiled with debug
assertions and removes it otherwise, whatever the environment says. Only then
does the host accept `WHISPERING_AUDIO_FIXTURE` and construct
`native/failure-injection.ts`. Injected publication failures are counted, so a
test can order failure and retry exactly. The injected commit failure is a real
lock file on the branch ref, created exclusively and tagged with a marker unique
to that host. The host removes only a lock carrying its own marker, so it never
takes or clears a lock another Git process holds.

## Where things are

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert folder declaration. |
| `src/lib/workspace/` | The storage seam and its two implementations. |
| `src/lib/bridge/` | Wire encoding, the remote `Folder`, and the HTTP transport. |
| `src/lib/session.svelte.ts` | The one session a mounted layout owns, and its context. |
| `src/lib/library.svelte.ts` | Product state: lists, selections, retained editors, pending captures, transcription and transformation runs, settings. |
| `src/lib/recordings/publish.ts` | Publication and recovery. |
| `src/lib/capture.ts`, `audio-format.ts`, `transcription.ts`, `transformation.ts` | Capture devices, container detection, the transcription and transformation requests. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/editor.svelte.ts`, `status.ts`, `files.ts`, `terminal.svelte.ts` | Drafts, status lines, the file tree, the terminal session. |
| `src/routes/` | The layout that owns the session, and the three pages. |
| `src/routes/components/` | The shell, navigation, header, unsaved notices, recorder, recording and transformation lists and details, file browser and view, terminal. |
| `src/lib/assets/` | The microphone mark from the earlier Whispering. |
| `native/` | The folder host: `main.ts`, `host.ts`, `folder-rpc.ts`, `terminal.ts`, `watch.ts`, `failure-injection.ts`. |
| `src-tauri/` | The shell. `shell/index.html` is shown only when the host cannot start. |
| [scripts/build-sidecar.ts](./scripts/build-sidecar.ts) | Compiles the host for the bundle. |
| `src/lib/tauri/bindings.gen.ts` | Generated by the Epicenter host's build for its own tests. Nothing here imports it. |
