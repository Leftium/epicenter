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
| `bun dev:honeycrisp` | Builds the desktop page, then starts the desktop app (`tauri dev`). |
| `bun build:honeycrisp` | Builds the desktop app bundle (`tauri build`). |
| `bun dev:honeycrisp:ui` | Starts the browser build on port 5175. Notes live in this browser's origin private file system (OPFS), not in a directory on disk. |
| `bun build:honeycrisp:ui` | Builds the browser page into `apps/honeycrisp/build`. |

Development and builds need Bun, Rust, Git, and the Tauri prerequisites for your
platform. The packaged app is one program and needs Git available on the
machine. It starts signed out and stays that way; it does not need the
Epicenter desktop app or the hosted API.

Checks, from `apps/honeycrisp`:

| Command | What it checks |
| --- | --- |
| `bun run typecheck` | Both page builds and the scripts. |
| `bun run test` | The page: editor, drafts, notes over a real directory, bundle contents. Needs no Rust. |
| `bun run test:native` | The shell: its Rust tests, then the page's close handling against the shell's real close gate. Needs Rust. |

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

A missing directory gets this layout and a Git repository. Creating its default
`kv.json` requests history asynchronously. An early note edit can join that
first commit. Existing data and history are left intact when opening.

A note's file stem is its identity. Its frontmatter holds `title`, `folderId`,
`pinned`, `createdAt`, `updatedAt`, and `deletedAt`; its body is the note.
Folders are logical: a note belongs to one through `folderId`, so moving a note
between folders changes one field and never moves or renames its file.

Saving a note writes its frontmatter in Honeycrisp's standard form: its fields
first in declared order, then any keys Honeycrisp does not know, every key
quoted and every value in JSON spelling. Unknown keys and their values are
kept; comments, quoting, and the earlier key order are not. The body is kept
exactly. Opening a note that is spelled differently writes nothing. To keep a
file's exact text, or to change a key Honeycrisp does not show, use **Edit as
file**.

A note file starts with a `---` line, its fields, and a closing `---` line.
A file in `notes/` whose text does not read that way, including plain
Markdown with no `---` lines, is still listed and still opens: it is marked
"Needs repair", its fields and rich-text view are unavailable, and you fix it
in Source. Saving it while it is still malformed works. A note that reads but
has a bad field, such as `pinned: maybe`, is marked the same way and keeps its
other controls and its rich-text view. The messages describe the text on
screen, saved or not.

Any file name works, for notes and for folders, including a leading dot, a
trailing space, and `notes/.md` itself. A folder's id is its file stem.

Deleting a folder first moves its notes out. It is refused while any note
cannot say which folder it is in: a note that does not read, a `folderId` that
is not valid, or a file that cannot be read as text. Repair or remove those
first.

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

Every opened file has one editing session, kept by its path, and never two:

- A note is a draft held by the folder's row editor. Its title, folder, and pin
  controls, the rich-text view, and the Source view all change that one
  draft, and a save writes the whole note in the standard form above,
  whatever the file holds.
- Any other text file, and a note the row editor cannot open, is a text
  session over the file's exact text. Its save lands only if the file is
  still the version it read.

**Edit as file** hands a note with nothing unsaved to a text session. **Open
as note** hands it back once its text is saved and reads as a note.
Renaming a file moves its session with it instead of opening a second one.
Each mutation reserves its paths before preparation starts, including its
rename destination or recovery target. Opening a reserved path cannot create
a competing editor. Close waits for preparation already admitted, and its
input fence prevents a new publication.

For a note:

| What happened | What Honeycrisp does |
| --- | --- |
| The file changed and you had no unsaved edits | Shows the new file. Nothing is written back. |
| The file changed and you had unsaved edits | Keeps your draft, stops autosaving, and offers **Compare and choose**. The comparison shows one version of the file, and **Discard my draft and load the file** and **Save my draft over the file** apply to exactly that version. If the file changes again while it is open, both are held back until you look at the new version. |
| You typed while a save was running | The newer typing stays a draft and saves next. |
| Fields need fixing | The note is not saved, and the fields are named. Your input stays on screen. |
| A save failed | Your draft is kept, with **Try again**, and nothing more is saved until you choose. |
| A save got no reply | It is shown as not confirmed: the file may or may not have it. Nothing more is saved until you choose **Save again** or **Keep the file as it is**. A read that finds your draft in the file says what the file holds, not which save put it there, so the save stays not confirmed. |
| The file was deleted, can no longer be read, or changed into text the note editor cannot hold | Your draft is kept, with **Copy draft**, **Save draft as a note** or **Save my draft over the file**, and **Discard draft** (or **Discard draft and repair the file**, which opens it as text). |
| A rename or delete got no reply, or a rename created the new file without removing the old one | The editor stays where it was, keeps what you type, and saves nothing more. **Copy draft** keeps your text, and **Stop tracking this rename** (or **delete**) keeps the draft without concluding where the file is; nothing saves by itself after that until you choose. |
| You rename or delete a note | It applies to the version the editor holds. If another program changed the file since, nothing is renamed or deleted, and the editor shows that change. A confirmed rename opens the note at its new name with everything you typed. |
| You open another note | Each note keeps its draft. |

A text session keeps these apart: the saved file it last agreed with, your
draft, the exact text a save submitted, a rename or delete that was submitted,
and any other version seen on disk. Its save is refused, writing nothing, when
the file is no longer the version it read. It offers the same choices as a
note: **Compare and choose**, **Save again** or **Try again** (a new save of
what is on screen), and **Keep the file as it is**. A save that got no reply
stays not confirmed even when a read finds its text. A draft saved back after
its file was deleted goes to the same path. A note file whose path meanwhile
holds a different file becomes a new note; a save sent after one that got no
reply is never moved to another path.

A change to a file that is not open and got no reply (a new note, a pin, a
rename or delete from Files) is listed under **Not confirmed** in the status
menu, never as failed. Nothing else is changed at that file from the app, and
a second new note is not made under another name. A new file or a field change
clears when the folder shows exactly what was asked for, and can be sent again
exactly. A rename or delete stays listed for as long as the app runs;
restarting stops listing it and does not show that it did or did not happen.
Closing waits for a change that is still being sent, and asks before leaving
one that was never confirmed.

A note's save is not conditional: a write by another program that lands
between the editor's last read and the save is replaced. A text session's save
checks the file just before it replaces it, and on a real directory that check
is not atomic either: another program can still write in the instant between
the check and the replacement. A refused save means staleness was detected; it
is not a guarantee that every stale save is caught.

Drafts exist only in the open window. Closing the window, quitting the app
(including Cmd+Q), and reloading the page are held back while any draft is
unsaved: Honeycrisp saves what it can, and asks before discarding the rest.
Any change that was not confirmed counts too, with or without an open
editor, and the prompt says so: quitting stops keeping track of it and does
not cancel it. A draft does not
survive the app being killed or crashing.

While the desktop app answers a close it takes no input: typing, buttons,
menus, and the terminal do nothing until you choose **Keep editing** or the
app closes. The
editors stay as they are, with their undo history. A browser tab has no such
step; its leave prompt is the browser's.

Every native close asks the page. The shell cannot infer permission from an
earlier observation of the drafts: once the notes are open, only the page's
answer to that one request lets a close through. A page that does not answer
is asked again on the next attempt, and the window stays.

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
changes do not. A command is stopped after two minutes, along with anything it
started, and output past 1 MB is cut off. In the browser build the terminal is
an emulated shell over the browser folder with a subset of Git commands.

## Git

History is ordinary Git in `<root>/.git`. A successful content save from an
editor or the file browser is committed, and the save does not wait for the
commit. A commit that fails is reported under **Git history** and leaves the
saved file saved; it is never shown as a save error. The browser terminal
follows the same automatic history policy. Desktop terminal commands and other
programs edit disk directly; their changes enter the next commit, automatic or
explicit. In the browser terminal, automatic history refuses `git add` and
`git commit`; staged authoring requires a folder opened with
`commitOnEdit: false`.

Each note has a **History** button listing its commits. Choosing a version
puts it in your draft; nothing is saved until the draft saves. A version that
is not text, or is larger than 16 MB, is refused instead of shown.

## How the desktop app is built

```text
Tauri shell (src-tauri)          one program and one window. It registers the
        │                        notes directory with the shared folder plugin
        │                        and asks the page before a close or quit.
        ▼
Folder plugin                    owns the directory: conditional file writes,
        │                        the root lock, change detection, Git history.
        │                        It is the Rust crate in
        │                        packages/tauri-plugin-epicenter-folder.
        ▼
Page (build-desktop, bundled)    opens the folder by its ID through
                                 @epicenter/folder and calls the shell's own
                                 commands. Frontmatter and drafts stay in the
                                 page.
```

The page chooses where its folder lives at build time through
`#platform/notes-host`. The desktop leaf opens the shell's folder with
`openFolder` from `@epicenter/folder/tauri`; the browser leaf opens one OPFS
directory, `Epicenter/local/so.epicenter.honeycrisp`, holding the notes and
their `.git`, with `openFolder` from `@epicenter/folder/browser`. A browser
folder an earlier version kept in IndexedDB is not read, copied, or deleted;
the browser opens the OPFS directory alone. Shared code
imports the folder contract from the bare `@epicenter/folder`, which
`vite.config.ts` aliases to the build's one entry. A desktop folder that
cannot be opened is an error on screen, never a fallback to browser storage.
`src/lib/platform-selection.test.ts` checks that the desktop bundle holds no
browser store and no Git implementation, that neither bundle holds a Yjs or
Node module, and that the browser bundle holds no desktop adapter.

A note's fields and body are saved by its row editor
(`folder.tables.notes.edit`), which writes the whole note; a new note or
folder is `tables.<name>.create`. Every other change names a capture:
`files.create` for a file that must not exist, and `files.replace`,
`files.move`, and `files.remove` on the capture the session holds.
`folder.onFilesChanged` is a hint to read again.

### What the shell decides

The page names one thing, the scope `so.epicenter.honeycrisp`. The shell
decides the rest in Rust, before any page exists:

- The root: `HONEYCRISP_ROOT`, else the default directory above. The shell
  makes the directory itself if it is missing and writes nothing inside it.
- The commit author: the owner reads the root's Git identity after taking its
  lock, with `Honeycrisp <honeycrisp@localhost>` as the fallback.
- Where history goes: nowhere but the directory. The folder is registered
  with no remote, and a repository that names an `origin` is still opened
  without one.
- Which window may use the folder and the commands: `main`, through
  `src-tauri/capabilities/main.json`. The window loads the bundled page and
  refuses to navigate anywhere else, including the same host on another port
  or an address carrying credentials.

The layout is set up by the page, through the folder, after the folder plugin
holds the directory's lock (`src/lib/platform/first-open.ts`). It looks first:
a missing table directory is made, and `kv.json` is written only when a read
confirmed it is absent, on the condition that it still is. The owner requests
history asynchronously after that save; an early note edit can join the same
commit. Opening a folder that already has its `kv.json`
writes nothing and requests no commit, whether or not it has any history. A
directory another Epicenter holds is reported as in use and gains no file.

### Shell commands

Besides the folder plugin's commands, the page calls these. None takes a root
or a working directory.

| Command | Purpose |
| --- | --- |
| `close_register`, `close_opened`, `close_approve`, `close_decline` | Close consent, below. |
| `shell_info` | The root, and where the terminal's next command starts. |
| `terminal_run` | One command in `/bin/sh`. The shell keeps the working directory between commands, so hiding the terminal or reloading the page loses nothing. |
| `file_log`, `file_show` | One file's commits, and its text at one of them. The path must be a literal path inside the folder and the commit a hexadecimal id. |
| `reveal_folder` | Open the root in the system file manager. |

The terminal is an outside writer, exactly as another program is. It requests
no commit. The folder plugin notices its changes, and the page rereads after
each command.

### Close consent

Three things can close the app: the window's close button, an exit request
from the system, and the Quit menu item. On macOS a custom Quit item routes
Cmd+Q through the same path, because the predefined one bypasses Tauri's
preventable exit event. Each asks `src-tauri/src/close.rs`:

1. The page registers when it starts, before it opens the folder, and gets a
   generation. A reload registers again; the page before it can no longer
   answer.
2. Until the page says its folder is open, a close goes ahead: a page that is
   loading, or whose folder failed to open, holds no draft.
3. After that every close is held and the page receives a `close-requested`
   event naming a request. The page stops taking input, then saves what it
   can. With nothing left unsaved it approves; otherwise it asks, and **Keep
   editing** declines and takes input again. Input stays stopped while an
   approval is on its way. It is taken again only when the gate answers that
   the approval was not taken because the page was replaced or the request
   was already answered. Any other failure leaves input stopped, and the
   next close is asked again.
4. Only an approval naming the current page and the current request lets the
   close through. A declined request, a request from before a reload, and a
   second answer are refused.

A page that never answers is asked the same request again on the next attempt.
Nothing in the shell approves on its behalf, so if the page's process dies
after the notes opened, the window can only be force-quit.

## Testing failures by hand

There is no fault panel. The earlier one lived in the Bun folder host, which
is gone, and the shell does not wrap the folder's writes to bring it back.
Use a disposable directory, never the default one:

```sh
HONEYCRISP_ROOT=/tmp/honeycrisp-test bun dev:honeycrisp
```

Both failures below are real, made from the app's terminal or any other one,
and `src-tauri/src/tests.rs` runs the same two through the folder plugin.

| To see | Do this in the notes directory | Undo |
| --- | --- | --- |
| A save that fails: the draft is kept, with **Try again** | `chmod a-w notes`, then edit a note | `chmod u+w notes` |
| A commit that fails while the file stays saved | `touch .git/refs/heads/main.lock`, then edit a note | `rm .git/refs/heads/main.lock`, then **Commit saved files** |
| A file changed underneath an unsaved draft | While the first row's save is failing, `echo changed >> notes/<id>.md` | `chmod u+w notes`, then choose in the note |

What cannot be produced by hand in the running app is a save held open or
slowed on purpose, so that typing lands while it runs. Those orders are fixed
in tests instead: `src/lib/row-session.test.ts` (notes) and
`src/lib/file-session.test.ts` (text files) hold a save and type during it,
lose a reply before or after the write lands, and change the file under a
review; `src/lib/notes.folder.test.ts` does the same over a real directory.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, and the check that gates opening and editing. |
| `src/lib/editor/rich-session.ts` | The rich-text view's state, undo history, and tie to the draft. No DOM. |
| `src/lib/row-session.svelte.ts` | One open note: the app's autosave, holds, and rename and delete around the folder's row editor (`table.edit`), which owns the draft and its saves. |
| `src/lib/file-session.svelte.ts` | One open text file's session (any other file, or a note being repaired as text): saved capture, buffer, submitted attempt, external version, and the conditional file calls. |
| `src/lib/note-source.ts` | A note's body for the rich-text and Source views, list previews, and the field repair offered on a note open as text. |
| `src/lib/notes.svelte.ts` | Listings, selection, the one session kept per path, note and folder actions, and the input fence. |
| `src/lib/platform/` | The `#platform/notes-host` seam, its two leaves, and `shell.tauri.ts`, the page side of the shell's commands. |
| `src/routes/components/` | Header, folder list, note list, editors, files, terminal. |
| `src-tauri/src/lib.rs` | The desktop shell: the folder plugin, the notes scope, the window, close routing. |
| `src-tauri/src/root.rs` | Choosing and resolving the root directory. |
| `src/lib/platform/first-open.ts` | Setting up a folder that has no layout yet, through the attached folder. |
| `src-tauri/src/commands.rs` | The shell's commands, each a thin call into a module below. |
| `src-tauri/src/close.rs` | Whether a close or quit may go ahead. |
| `src-tauri/src/terminal.rs`, `history.rs`, `reveal.rs` | The terminal, per-file history, and reveal. |
| `src-tauri/capabilities/main.json` | What the notes window may call. |
| `native-tests/` | The page's close handling against the shell's real close gate. |

## Tech stack

The [desktop acceptance report](evidence/desktop/README.md) includes native
screenshots, saved Markdown and Git versions, checks, and verified limits. It
was made with the earlier Bun folder host. The
[native migration record](evidence/native-migration/README.md) says what
replaced the host and which native checks are still to be run.

- [SvelteKit](https://kit.svelte.dev) with the static adapter, SSR disabled
- [ProseMirror](https://prosemirror.net) with `prosemirror-history` and `prosemirror-markdown`
- `@epicenter/folder` for the folder, its note and folder listings, and the row editor notes are saved through, and `@epicenter/definition` for the declaration
- [Tauri](https://tauri.app) for the desktop shell, with the `tauri-plugin-epicenter-folder` crate owning the directory and its Git history
- `@epicenter/ui` and [Tailwind CSS](https://tailwindcss.com)
