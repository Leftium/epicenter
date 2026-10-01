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

`src/lib/definition.ts` declares the folder with `defineStore`: two tables and
`kv`. `@epicenter/app/files` turns that into Markdown rows at
`<table>/<stem>.md`, a same-stem attachment per row, and `kv.json`. The package's
[README](../../packages/app/README.md) is the contract for entries, conditional
writes, source-preserving patches, partial publication, and history.

What Whispering adds on top:

- A recording's identity is its stem. Results refer to it by `recordingId`, so
  the app never renames a recording's files; the title is a field.
- A transcription is a separate row, so a recording can have several and each is
  a readable file.
- The transcription key is not folder data. On the desktop it is in
  `<root>/.git/epicenter/whispering/device.json`, which Git never commits.

## The storage boundary

`src/lib/workspace/types.ts` is the one seam. `openWorkspace()` picks an
implementation when the page mounts:

| | Desktop (`desktop.ts`) | Browser (`browser.ts`) |
| --- | --- | --- |
| Folder | The real directory, through the bridge | A logical folder in IndexedDB (`openBrowserFolder`) |
| Terminal | Your shell in the directory | The in-page shell from `@epicenter/app/files/terminal` |
| Transcription | The host makes the request | The page makes the request |
| Key | A file under `.git` | `localStorage` |
| Outside changes | Watched and announced | None exist |
| Reveal, failure injection | Yes | No |

The desktop shell injects `window.__WHISPERING_BRIDGE__` before the page runs.
Its presence selects the desktop workspace; there is no build flag. Everything
above the seam (`library.svelte.ts`, the editors, the components) is the same
code for both. `src/lib/page-boundary.test.ts` fails if anything under `src/`
imports a Node, Bun, or Tauri module, the native folder opener, or the Yjs
store.

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
`credential`, and, in a debug shell only, `fixture`, `inject`, and `injection`.

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

## Drafts and conflicts

`src/lib/editor.svelte.ts` holds one draft per open file: the text on screen
and the saved file its next conditional save is checked against. A recording's
Details and Source views read and write the same draft.

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
warning. The page acknowledges every request with `asking` before it does
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

The host opens the folder with automatic commits on and no remote. A managed
save requests a commit and does not wait for it. `src/lib/status.ts` turns the
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
| `src/lib/library.svelte.ts` | Product state: lists, selection, retained editors, pending captures, transcription runs, settings. |
| `src/lib/recordings/publish.ts` | Publication and recovery. |
| `src/lib/capture.ts`, `audio-format.ts`, `transcription.ts` | Capture devices, container detection, the transcription request. |
| `src/lib/audio-source.ts` | What a player holds, reloaded by content version on each folder refresh. |
| `src/lib/editor.svelte.ts`, `status.ts`, `files.ts`, `terminal.svelte.ts` | Drafts, status lines, the file tree, the terminal session. |
| `src/routes/components/` | Header, recording list and details, file browser and view, terminal. |
| `native/` | The folder host: `main.ts`, `host.ts`, `folder-rpc.ts`, `terminal.ts`, `watch.ts`, `failure-injection.ts`. |
| `src-tauri/` | The shell. `shell/index.html` is shown only when the host cannot start. |
| [scripts/build-sidecar.ts](./scripts/build-sidecar.ts) | Compiles the host for the bundle. |
| `src/lib/tauri/bindings.gen.ts` | Generated by the Epicenter host's build for its own tests. Nothing here imports it. |
