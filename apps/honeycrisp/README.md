# Honeycrisp

Honeycrisp is a Markdown notes app with a rich-text editor. Every note is one
Markdown file in a folder you own, and that folder's files are the saved data.
There is no account, no sync, and no database behind it.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
Licensed under AGPL-3.0-or-later.

## Run it

From the repository root:

| Command | What it does |
| --- | --- |
| `bun dev:honeycrisp` | Builds the page and the folder host, then starts the desktop app (`tauri dev`). |
| `bun build:honeycrisp` | Builds the desktop app bundle (`tauri build`). |
| `bun dev:honeycrisp:ui` | Starts the browser build on port 5175. Notes live in this browser, not in a directory. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

Development and builds need Bun, Rust, Git, and the Tauri prerequisites for your
platform. The packaged app includes its file host and needs Git available on
the machine. It starts signed out and stays that way; it does not need the
Epicenter desktop app or the hosted API.

Checks: `bun run --cwd apps/honeycrisp typecheck` and
`bun run --cwd apps/honeycrisp test`.

## Where notes live

```text
~/Epicenter/local/so.epicenter.honeycrisp/
├── kv.json
├── notes/
│   └── <note-id>.md
├── folders/
│   └── <folder-id>.md
└── .git/
```

Set `HONEYCRISP_ROOT` to use another directory, for example a disposable one
for testing:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun dev:honeycrisp
```

A missing directory is created with this layout and a Git repository whose
first commit is `kv.json`. An existing directory is opened as it is.

A note's file stem is its identity. Its frontmatter holds `title`, `folderId`,
`pinned`, `createdAt`, `updatedAt`, and `deletedAt`; its body is the note.
Folders are logical: a note belongs to one through `folderId`, so moving a note
between folders changes one field and never moves or renames its file. Keys
Honeycrisp does not know, comments, quoting, and key order in frontmatter are
kept as written.

## Editing

A note has two views of one draft: **Rich text** and **Source**. Switching
between them saves nothing and discards nothing. The draft saves on its own a
moment after you stop typing.

Opening a note does not change its file. A rich-text edit rewrites the body as
Markdown and may respell it (`_a_` becomes `*a*`), without changing what it
says.

The rich-text view edits paragraphs, headings, bold, italic, strikethrough,
inline code, links, bullet, numbered, and task lists, quotes, code blocks,
dividers, and line breaks. There is no underline and there are no images.

- **Source the editor cannot hold stays in Source.** A note containing HTML,
  an image, or a table opens in Source only, with the reason shown. The
  rich-text view is refused for it rather than risk changing it.
- **An edit Markdown cannot spell is refused before it appears.** Two are
  known: bold, italic, or strikethrough that starts or ends with punctuation
  directly against a letter (`a**(b)**`), and a line break inside a heading.
  The editor says so; add a space, or make the change in Source.
- **Three things are not kept as content,** because Markdown has no spelling
  for them: an empty paragraph, a line break with nothing after it in its
  block, and bold, italic, or strikethrough on a space by itself.
- Spaces at the start or end of a line are kept. In Source they appear as
  `&#32;` (and a tab as `&#9;`), since Markdown would drop them otherwise.
- Inline code is literal: it can be a link, but not bold, italic, or struck.

## When the file changes underneath you

Each open note keeps four things apart: the saved file it last agreed with,
your draft, the text a running save captured, and any newer version seen on
disk.

| What happened | What Honeycrisp does |
| --- | --- |
| The file changed and you had no unsaved edits | Shows the new file. Nothing is written back. Undo history restarts. |
| The file changed and you had unsaved edits | Keeps your draft, stops autosaving, and offers **Compare**, **Discard my draft and load the file**, and **Save my draft over the file**. |
| You typed while a save was running | The save accepts only the text it captured. The newer typing stays a draft and saves next. |
| Your save was based on an older file | The save is refused and writes nothing. Your draft is kept. |
| A save failed | Your draft is kept, with **Try again**. |
| The file was deleted, or can no longer be read as text | Your draft is kept, with **Copy draft**, **Save draft as a note**, and **Discard draft**. |
| You open another note | Each note keeps its draft. |

A save checks the file just before it replaces it. On a real directory that
check is not atomic: another program can still write in the instant between
the check and the replacement, and that write would be lost. A refused save
means staleness was detected; it is not a guarantee that every stale save is
caught.

Drafts exist only in the open window. Closing the window, quitting the app
(including Cmd+Q), and reloading the page are held back while any draft is
unsaved: Honeycrisp saves what it can, and asks before discarding the rest.
A draft does not survive the app being killed or crashing.

Every native close asks the page. The shell cannot infer permission from an
earlier observation of the drafts. If the file process stops, the window keeps
its drafts; closing asks whether to stay and
copy them from Source or explicitly discard them.

## Header controls

| Control | What it does |
| --- | --- |
| Status | The most important current fact. Open it for three separate lines: **Drafts** (text in this window), **Saved files** (files not yet committed), and **Git history** (the last commit attempt), plus recent commits, **Check again**, and **Commit saved files**. |
| Files (Ctrl+B) | The file browser for the same directory: open, create, rename, and delete any file. **Reveal folder** opens the directory in the system file manager. |
| Terminal (Ctrl+`) | A shell in the same directory. Its output, history, typed command, and working directory stay while it is hidden. |

On the desktop the terminal runs each command in `/bin/sh` with the real
`git`, so it is exactly an outside program editing the same files. It is a
command runner, not a terminal emulator: a command gets no keyboard input, and
its output appears when it ends. `cd` carries to the next command; environment
changes do not. In the browser build the terminal is an emulated shell over the
browser folder with a subset of Git commands.

## Git

History is ordinary Git in `<root>/.git`. A successful content save through
tables, KV, or the file browser requests a commit and does not wait for it. A commit that
fails is reported under **Git history** and leaves the saved file saved; it is
never shown as a save error. The browser terminal follows the same automatic
history policy. Desktop terminal commands and other programs edit disk directly;
their changes enter the next checkpoint or an explicit commit. In the browser
terminal, automatic history refuses `git add` and `git commit`; staged authoring
requires a folder opened with `commitOnEdit: false`.

Each note has a **History** button listing its commits. Choosing a version
puts it in your draft; nothing is saved until the draft saves.

## How the desktop app is built

```text
Tauri shell (src-tauri)          starts the host, opens one window, asks the
        │                        page before accepting close or quit
        ▼
Bun folder host (host/)          opens the directory with openNativeFolder,
        │                        serves the built page and /bridge on one
        │                        loopback origin
        ▼
Page (src/)                      reaches the folder with fetch; calls no
                                 native command
```

The page chooses where its folder lives at build time through
`#platform/notes-host`. The desktop leaf uses the bridge; the browser leaf
opens a logical folder in IndexedDB with `openBrowserFolder`. Neither leaf
imports a native module, and `src/lib/platform-selection.test.ts` checks both
bundles and the host for that and for the absence of any Yjs module.

### Bridge contract

The host listens on `127.0.0.1` at a port it picks. The shell generates a
token per launch, gives it to the host in its environment, and puts it in the
window before any page script runs. Every `/bridge` request carries
`Authorization: Bearer <token>`. The host refuses a `Host` header other than
its own and an `Origin` other than its own. The page is served with a content
security policy that allows only its own scripts and same-origin connections.

| Route | Purpose |
| --- | --- |
| `POST /bridge/call` | `{ path, args }` to `{ ok }` or `{ fault }`. `path` is one of `tables.<notes\|folders>.<list\|get\|create\|update\|writeSource\|rename\|delete>`, `kv.<get\|update\|writeSource>`, `files.<list\|children\|read\|open\|write\|remove\|move\|mkdir\|rmdir>`, `git.<snapshot\|status\|commit\|paths\|stage\|commitStaged\|diff\|log>`. Anything else is a fault. Results are the folder library's `Result` values unchanged. |
| `GET /bridge/events` | Newline-delimited JSON: `{type:"git",snapshot}` on every Git change, `{type:"files"}` after any change under the root, `{type:"closeRequested"}` when the shell held back a close, `{type:"ping"}`. |
| `POST /bridge/app` | Honeycrisp's own operations: `info`, `terminal`, `reveal`, `fileLog`, `show`, `faults`, `setFaults`, `closeReceived`, `quit`. |

Values are JSON with tags for what JSON cannot carry: `{"$t":"u"}` for
undefined, `{"$t":"b","v":"<base64>"}` for bytes, `{"$t":"m","v":[...]}` for a
Map, `{"$t":"e",...}` for an Error.

`/bridge/call`, the encoding, and `src/lib/bridge/folder-client.ts` contain
nothing specific to Honeycrisp. `host/serve.ts` requests the commit after a
content save itself, rather than leaving it to the folder, so a commit can be
made to fail in testing without touching the save.

Between the shell and the host: the host's first stdout line is
`{"ready":true,"port":<n>,"root":"<path>"}`; a later `{"quit":true}` line
approves closing. The shell writes `close-requested`
to the host's stdin when it holds back a close, and closing stdin stops the
host. `host/main.ts` lists every environment variable.

Only `quit` approves closing. A close request
waits across event-stream reconnects and page mounting until the page receives
it. On macOS, a custom Quit menu item routes Cmd+Q through this handshake;
the predefined Cocoa Quit action bypasses Tauri's preventable exit event.

## Testing with injected faults

Start with a disposable root and `HONEYCRISP_FAULTS=1`:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test HONEYCRISP_FAULTS=1 bun dev:honeycrisp
```

The status details then show a **Test faults** panel: hold saves until
released, delay saves by five seconds, fail the next save, fail the next
commit. `HONEYCRISP_HOLD_SAVES=1`, `HONEYCRISP_SAVE_DELAY_MS`,
`HONEYCRISP_FAIL_SAVES`, and `HONEYCRISP_FAIL_COMMITS` set the same faults at
launch. A held or delayed save waits before it reads the file, so the
conditional check still runs afterwards against whatever is on disk by then.

The host refuses `HONEYCRISP_FAULTS=1` without `HONEYCRISP_ROOT`, so faults
never run against the default notes directory.

A real commit failure needs no injection: `touch .git/refs/heads/main.lock` in
the terminal makes the next commit fail until the file is removed.

To run the host without the desktop shell, for example to open the desktop
page in an ordinary browser:

```sh
bun run --cwd apps/honeycrisp build:desktop-ui
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun run --cwd apps/honeycrisp host:standalone
```

It prints its address. In this mode the token is written into the served
page, so any local process that can fetch the page can read it. Use it for
development only.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, and the check that gates opening and editing. |
| `src/lib/editor/rich-session.ts` | The rich-text view's state, undo history, and tie to the draft. No DOM. |
| `src/lib/draft.svelte.ts` | One file's draft: accepted file, buffer, in-flight save, external version. |
| `src/lib/note-source.ts` | Source-preserving changes to a note's text. |
| `src/lib/notes.svelte.ts` | Listings, selection, retained drafts, and file actions. |
| `src/lib/bridge/` | The bridge contract, encoding, and page-side client. |
| `src/lib/platform/` | The `#platform/notes-host` seam and its two leaves. |
| `src/routes/components/` | Header, folder list, note list, editors, files, terminal. |
| `host/` | The Bun folder host: bridge, terminal, change detection, fault injection. |
| `src-tauri/` | The desktop shell. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) includes native
screenshots, saved Markdown and Git versions, checks, and verified limits.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/app/files` for file tables, source-preserving frontmatter, and Git history
- [Tauri](https://tauri.app) for the desktop shell, [Bun](https://bun.sh) for the folder host
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)
