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
| `bun run test` | The page: editor, drafts, notes over a real directory and over the browser folder, bundle contents, then `test:dom`. Needs no Rust. It first prepares the folder package's file exchange addon, which needs a C compiler on macOS and Linux. |
| `bun run test:dom` | The note view, mounted with its UI library over jsdom, in its own process. |
| `bun run test:native` | The shell: its Rust tests, then the page's close handling against the shell's real close gate. Needs Rust. |
| `bun run test:quit` | macOS only, run by hand in a login session: the real app, on a fixture page in a fresh directory, quit through AppKit's `terminate:` twice. The first quit is declined; the second is approved while a save is still being written. See [the quit evidence](evidence/native-quit/README.md). Opens a window. |

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

Saving a note from its fields, rich text, or Source writes its frontmatter in
Honeycrisp's standard form: its fields first in declared order, then any keys
Honeycrisp does not know, every key quoted and every value in JSON spelling.
Unknown keys and their values are kept; comments, quoting, and the earlier key
order are not. The body is kept exactly. Opening a note that is spelled
differently writes nothing. To keep a file's exact text, or to change a key
Honeycrisp does not show, use **Edit as file**: it saves exactly what you type.

An action from the note list or the folder list on a note or folder that is
not open (pin, move to a folder, move to Recently Deleted, restore, rename a
folder) changes that one field in the file's text and keeps every other byte,
comments and quoting included. It writes even when the field already has that
value. A note that is open takes the action in its editor, which saves in the
standard form.

A note file starts with a `---` line, its fields, and a closing `---` line.
A file in `notes/` whose text does not read that way, including plain
Markdown with no `---` lines, is still listed and still opens: it is marked
"Needs repair", its fields and rich-text view are unavailable, and you fix it
in its file view, in the same editor. Saving it while it is still malformed
works. A note that reads but has a bad field, such as `pinned: maybe`, is
marked the same way and opens in its file view too. Its list actions stay
available when the fields they need read: it can be moved to a folder or to
Recently Deleted, but not pinned or unpinned while `pinned` is bad. The
messages describe the text on screen, saved or not. A file in `notes/` that is
not text at all is listed apart and opens nothing; rename, delete, and the
terminal still work on it.

Any file name works, for notes and for folders, including a leading dot, a
trailing space, and `notes/.md` itself. A folder's id is its file stem.

Deleting a folder first moves its notes out. It is refused while any note
cannot say which folder it is in: a note that does not read, a `folderId` that
is not valid, or a file that cannot be read as text. Repair or remove those
first. It is also refused before any note moves while an open note holds text the
note list does not show yet (its save is still running or stopped, or it was
reloaded since the list was read) and that text or the listed file puts it in
the folder, while a change to a note is still running, or while an
unconfirmed change could put a note in it. A note whose other fields need repair is moved out with the rest of its
text kept. A note that changed since the list was read stops the delete, so a
move made elsewhere is not undone. After the notes move, the folder is read
again and the same checks run before its file goes.

This covers the notes the app knows of, and it is not one atomic step: a note
already moved out stays moved out if the delete stops, and another program can
still put a note in the folder after the last read. A note whose folder is
gone shows under All Notes.

## Editing

A note has three views of one text: **Rich text** and **Source** for its
body, beside its title, folder, and pin, and **Edit as file** for its whole
text. Switching between them saves nothing and discards nothing. Every edit
saves as you make it; typing while a save runs saves next, and only the latest
text waits.

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

- A note is one row editor of the folder. Its title, folder, and pin
  controls, the rich-text view, the Source view, and its file view all change
  that one editor's text, and each save writes the whole note over whatever
  the file holds: the last writer wins. A save never creates the file. An
  open note never picks up another program's change by itself; **Reload
  file** reads the file into it when you ask.
- Any other text file is a text session over the file's exact text. Its save
  lands only if the file is still the version it read.

**Edit as file** shows the same note's whole text, in the same editor.
**Open as note** shows its fields again once the text reads as a note. A note that does not read as one is repaired there; it is never
handed to a text session. Renaming a file moves its session with it instead
of opening a second one; a note's editor is fixed to its path, so a renamed
note gets a new editor at its new name, and the view stays. Each mutation
reserves its paths before preparation starts, including its rename
destination or recovery target. Opening a reserved path cannot create a
competing editor. Close waits for preparation already admitted, and its input
fence prevents a new publication.

For a note:

| What happened | What Honeycrisp does |
| --- | --- |
| Another program changed the file | The open note keeps its text and saves nothing until you type. **Reload file** shows the file in its place; with text that is not saved it asks first. Your next save replaces the file. |
| You typed while a save was running | The newer typing saves next. |
| Your text does not read as a note | It is saved as you type it, and the note shows its file view with the problems named until it reads as a note again. |
| A value cannot be written at all, such as a title with half of an emoji | It is not saved, and the note says why. What you typed stays in that field until you change it, and counts as unsaved at close. In the rich-text view the keystroke is refused instead. |
| A save failed | Your text stays editable and the error stays visible, including during a later save, until a newer save or reload succeeds. A waiting edit proceeds, and later typing saves again. **Try again** saves the current text without changing it. **Reload file** replaces your text with the file. |
| A save got no reply, or the folder threw an error during the save | It is shown as not confirmed, with the folder's own words, such as where it kept text it displaced: the file may or may not have it. A waiting edit proceeds, and later typing saves again. **Save again** resubmits the current text; **Reload file** replaces it with the file. |
| A reload could not read the file | Your text and its save state stay as they were, and the note says why. |
| The file was deleted | The note stays open with your text. Its next save, or a reload, finds no file and says so; nothing writes the file back by itself. **Save as a note** creates it again, exactly as the editor holds it, while the path is free, and as a new note when another file took the path; that file stays as it is. Text a file cannot hold exactly, such as half of an emoji, is not saved as a file at all, and **Save as a note** waits while such a value you typed is still in a field. |
| Your text was saved as a file that then would not open | Your text stays on screen, exactly as saved, with **Copy text** and **Try opening again**, and counts as unsaved at close until the note opens or you choose **Stop keeping this text**. |
| A rename or delete got no reply, or a rename created the new file without removing the old one | The editor stays where it was, takes no typing, and saves nothing, since a save would land at the old path. **Copy text** keeps your text, and **Stop tracking this rename** (or **delete**) concludes nothing about where the file is; typing waits until you choose **Save at** the old name or **Reload file**. |
| You rename or delete a note | Typing waits while it runs. Its saves finish first, then the file is read: if it holds other text than the editor, nothing is renamed or deleted, and **Reload file** shows that text. A delete removes exactly the version you confirmed and reads nothing after you confirm. A confirmed rename opens the note at its new name. |
| You move an open note to Recently Deleted or restore it, or pin or move it from the note list, while the note shows its file, or a rename or delete of it runs or is not finished | Refused, and the note is unchanged. A running or failed save does not block the action: it submits the complete current document after any running save. |
| You open another note | Each note keeps its editor and its text. |

A text session keeps these apart: the saved file it last agreed with, your
draft, the exact text a save submitted, a rename or delete that was submitted,
and any other version seen on disk. Its save is refused, writing nothing, when
the file is no longer the version it read. It offers the same choices as a
note: **Compare and choose**, **Save again** or **Try again** (a new save of
what is on screen), and **Keep the file as it is**. A save that got no reply
stays not confirmed even when a read finds its text. A draft saved back after
its file was deleted goes to the same path, only while it is free, and is
never moved to another path.

A change to a file that is not open and got no reply (a new note, a pin, a
rename or delete from Files) is listed under **Not confirmed** in the status
menu, never as failed. Nothing else is changed at that file from the app, and
a second new note is not made under another name. A new file or a field change
is marked when the folder shows exactly what was asked for, and stays listed
until you dismiss it or send it again and that is confirmed. A field change is
sent again under its first condition: one that moved a note out of a folder
being deleted applies only while the note is still the version that was
listed. A rename or delete stays listed for as long as the app runs;
restarting stops listing it and does not show that it did or did not happen.
Closing waits for a change that is still being sent, and asks before leaving
one that was never confirmed.

A note's save is not conditional: a write by another program that lands
between the editor's last read and the save is replaced. It does require the
file: a note removed before its save lands stays removed. A list action on a
note that is not open reads the file and writes only over what it read; a
write in between refuses it. A text session's save
checks the file just before it replaces it, and on a real directory that check
is not atomic either: another program can still write in the instant between
the check and the replacement. A refused save means staleness was detected; it
is not a guarantee that every stale save is caught.

Unsaved text exists only in the open window. Closing the window, quitting the
app (including Cmd+Q), and reloading the page are held back while any text is
unsaved: Honeycrisp waits for saves already running, saves text-file drafts
it can, and asks before discarding the rest. A note whose save failed is not
tried again for you. Any change that was not confirmed counts too, with or
without an open editor, and the prompt says so: quitting stops keeping track
of it and does not cancel it. Unsaved text does not survive the app being
killed or crashing.

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
puts it in the open note, which saves it like any edit. A version that
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

An open note is saved by its row editor (`folder.tables.notes.edit`): each
edit gives it the complete document with `set`, or the file view's exact text
with `setText`, and the editor writes the whole note by replacing the existing
file, one write at a time with only the latest waiting. After a failed write
the latest waiting input proceeds, and later input starts another save.
`retry` resubmits the current text; `flush` waits for all consecutive admitted
writes and reports the final outcome, and
`reload` is the one read of the file after opening. The views read it
through `fromRowEditor` from `@epicenter/folder/svelte`. A deleted note is
created again only by `files.create`, at the person's request. A field change to a
note or folder with no editor is `tables.<name>.update`, which assigns those
fields in the current text and publishes only over the bytes it read, under
`{}` or the listed `expectedSha256`. A new note or folder is
`tables.<name>.create`. Every other change names a capture:
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

Four things can close the app: the window's close button, an exit request
from the run loop, the Quit menu item, and on macOS a quit from the system.
On macOS a custom Quit item routes Cmd+Q through the same path, because the
predefined one bypasses Tauri's preventable exit event. A quit from the Dock,
a logout, or an Apple Event is AppKit's `terminate:`. Tao's application
delegate does not answer `applicationShouldTerminate:`, so AppKit would end
the app without an exit event. During setup, `src-tauri/src/quit.rs` adds
that one method to Tao's existing delegate class. It always cancels the
system quit and asks for an ordinary exit instead, so the gate decides. As a
result, a logout or restart is cancelled every time, even with nothing
unsaved, and it is never resumed. Start it again once Honeycrisp has exited.
If the method cannot be added, the app does not start. Each way out asks
`src-tauri/src/close.rs`:

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
after the notes opened, the window can only be force-quit, which loses any
unsaved draft. Until then a logout or restart stays cancelled.

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
| A save that fails: your text stays editable, with **Try again** | `chmod a-w notes`, then edit a note | `chmod u+w notes`, then **Try again** |
| A commit that fails while the file stays saved | `touch .git/refs/heads/main.lock`, then edit a note | `rm .git/refs/heads/main.lock`, then **Commit saved files** |
| A reload that cannot read the file: your text stays as it was | With a note open, `printf '\377' > notes/<id>.md`, then **Reload file** | Type in the note to save over it, or restore the file from Git |
| A note file deleted under you: nothing writes it back | With a note open, `rm notes/<id>.md`, then type in it | **Save as a note**, or restore the file from Git |

What cannot be produced by hand in the running app is a save held open or
slowed on purpose, so that typing lands while it runs, or a reply lost after
the write landed. Those orders are fixed in tests instead, over the folder's
own row editor with faults in its storage stand-in:
`src/lib/note-session.test.ts` (one note) and `src/lib/file-session.test.ts`
(text files) hold a save and type during it, lose a reply before or after the
write lands, and change the file under an open editor; `src/lib/notes.folder.test.ts`
does the same with the notes state, over a real directory and over the browser
folder. `src/routes/components/NoteDetail.dom.test.ts` mounts the note view
and delivers events to it, including to controls that outlived it.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/data.ts` | The inert declaration: the `notes` and `folders` tables. |
| `src/lib/editor/schema.ts` | The bounded ProseMirror schema. |
| `src/lib/editor/markdown.ts` | Markdown to document and back, the equivalence it is held to, and the check that gates opening and editing. |
| `src/lib/editor/rich-session.ts` | The rich-text view's state, undo history, and tie to the note's body. No DOM. |
| `src/lib/note-session.svelte.ts` | One open note's policy around the folder's row editor (`table.edit`): the fields or file view, when input is taken, typed text the editor refused, the person's Try again and Reload file, and the fences around a rename, delete, or close. The row editor owns the note's text and its writes. |
| `src/lib/file-session.svelte.ts` | One open text file's session (any file that is not a note): saved capture, buffer, submitted attempt, external version, and the conditional file calls. |
| `src/lib/note-source.ts` | A note's body for the rich-text and Source views, list previews, and the field repair offered in a note's file view. |
| `src/lib/notes.svelte.ts` | Listings, selection, the one session kept per path, note and folder actions, and the input fence. |
| `src/lib/platform/` | The `#platform/notes-host` seam, its two leaves, and `shell.tauri.ts`, the page side of the shell's commands. |
| `src/routes/components/` | Header, folder list, note list, editors, files, terminal. |
| `src-tauri/src/lib.rs` | The desktop shell: the folder plugin, the notes scope, the window, close routing. |
| `src-tauri/src/root.rs` | Choosing and resolving the root directory. |
| `src/lib/platform/first-open.ts` | Setting up a folder that has no layout yet, through the attached folder. |
| `src-tauri/src/commands.rs` | The shell's commands, each a thin call into a module below. |
| `src-tauri/src/close.rs` | Whether a close or quit may go ahead. |
| `src-tauri/src/quit.rs` | macOS: a quit from the system becomes an exit request the gate answers. |
| `src-tauri/examples/quit/` | macOS: the real app quit through `terminate:` on a fixture page (`bun run test:quit`). |
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
