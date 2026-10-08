# Todos

A file-first todo list. Each todo is a plain Markdown file, `todos/<stem>.md`,
with `title` and `done` in frontmatter and notes in the body. A file browser
shows every file in the folder, and a terminal edits the same files and runs
Git commands against the folder's history.

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory on this computer, opened by the Epicenter host. | Real Git in that directory's `.git`. No remote unless you add one. |
| Browser demo | A folder in this browser's origin private file system (OPFS). | Git in the folder's `.git`, in OPFS beside the files, with a loopback remote for the demo. |

Todos uses no hosted API, account, or secrets in either build. It is built on
`@epicenter/folder` and does not depend on `@epicenter/app`. A folder that
cannot be opened is shown as that refusal. The desktop build never falls back
to browser storage.

A todo is its Markdown file and nothing else. A file that shares a todo's stem,
such as `todos/milk.png` or `todos/milk.webm` beside `todos/milk.md`, is an
ordinary file: renaming or deleting the todo leaves it where it is, and you
rename or delete it yourself from the file browser.

## Desktop, inside Epicenter

Todos is one of Epicenter's compiled applications. Open it from Epicenter Home,
or through the `epicenter://app/todos` link. There is no separate Todos app to
install or run.

### Where the files are

The todos are files in `so.epicenter.todos` under Epicenter's working-copy
directory:

| Build of Epicenter | Directory |
| --- | --- |
| Production | `~/Epicenter/so.epicenter.todos` |
| Development (`bun dev:epicenter`) | `~/Epicenter Dev/so.epicenter.todos` |
| `EPICENTER_FOLDER_DIR` set to `/some/dir` | `/some/dir/so.epicenter.todos` |

The header shows the directory's real path, and the status details have a
"Copy path" button. Epicenter creates the directory and its `todos/` folder the
first time Todos opens, and initializes Git there. It never overwrites a file
that is already present. Native startup chooses the directory; nothing in the
window can point Todos at another one.

Edit the files with any program. Todos rereads when the operating system
reports a change under the directory, including to its Git state (a commit, a
staged file, a branch change). App mutations refresh the watcher's baseline.
A timer also compares each file's size and modification time, which recovers
a change whose report never arrived. A
change that is neither reported nor visible in size or time is not noticed
until the next reread; returning to the window and "Check again" both reread.
A reread updates the list and the file browser and never replaces what you
have typed. A plain editor with nothing unsaved shows the new text; one with
unsaved typing keeps it and reports a conflict at its next save. An open todo
reads its file when it opens and again only when you press **Reload** in its
status bar; until then it shows what it loaded, and your next edit to it
writes the whole todo over the change made elsewhere.

### Saving and committing

- Saving a todo writes its file, then Epicenter commits the folder. The save
  does not wait for the commit, and a commit that fails is shown in the status
  details, never as a failed save.
- Saving any other file in the plain editor, and content writes in the embedded
  terminal, follow the same automatic history policy.
- A new folder has no Git remote, and the window says so: Pull and Fetch are
  off, and the commit button reads "Commit". To use a remote, add one named
  `origin` with your own Git in the directory, then reopen Epicenter. Todos
  records automatic commits locally and offers Commit and push and Pull. It follows `main`
  only.
- The terminal is the same restricted shell as the browser demo, over the real
  directory. It is not `/bin/sh`: it has the listed file commands and
  `git status`, `diff`, `log`, `push`, `fetch`, and
  `pull --ff-only`, and it cannot reach outside the folder. For anything else,
  use your own terminal in the directory. Automatic history refuses staged
  authoring through `git add` and `git commit`; those commands require a folder
  opened with `commitOnEdit: false`.

### What is and is not protected

- One Epicenter owns the directory at a time. A second one pointed at the same
  directory (a development and a production build sharing
  `EPICENTER_FOLDER_DIR`) is refused when Todos opens, with a message naming
  the directory. The lock is a file beside the directory,
  `.so.epicenter.todos.epicenter-lock`. The operating system releases it when
  Epicenter exits, including after a crash or a forced kill, so there is
  nothing to clean up and the file is never deleted. It is not reliable on
  network filesystems. A symbolic link or anything but a regular file at that
  path is refused when Todos opens; a link swapped in while it runs is not
  defended against.
- The lock is between Epicenter processes. Other programs are not asked to
  take it. A todo's fields and its source save the whole file over whatever
  it holds, but only while the file exists: a todo deleted elsewhere is not
  written back. The last write wins: the todo reads the file only when it
  opens or you reload it, so another program's edit since then is
  overwritten by your next edit. A plain editor saves only if the file still has the version it
  read, and checks again after staging the new bytes, immediately before
  replacing the file; an edit that lands in the instant between that last
  check and the replacement is overwritten. Neither is an operating-system
  compare-and-swap, and nothing merges.
- A rename or delete of a todo changes one file, its Markdown file. A failure
  is reported as it happened: a refusal wrote nothing, and a reply that never
  arrived says the change may have landed, with the folder's own detail.
  Nothing is retried or rolled back.
- Todos refuses to open a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule), or whose
  `.git/epicenter/scratch` is linked elsewhere. It checks this when it opens
  the directory; it does not defend against a program that swaps a link in
  while it runs. Symbolic links among the files are not followed.
- Git commands Epicenter runs ignore inherited `GIT_DIR`, `GIT_WORK_TREE`, and
  `GIT_INDEX_FILE`, and never fall through to a repository in a parent
  directory.

### Closing, quitting, and unsaved typing

Unsaved typing lives only in the open window. A todo saves each edit as you
make it, and a plain editor saves after a short pause, so the cases below are
about input that could not be saved: a conflict, a failed save, or a save
still running.

- Closing the Todos window hides it. The page stays loaded, so unsaved input
  and the terminal's output are still there when you open Todos again.
- Quitting Epicenter, or restarting it for an account change, asks this page
  first, over the host's departure wire (`@epicenter/epicenter/departure`).
  From that moment the page takes no typing and starts no action, Git
  command, or terminal command. A page holding nothing unsaved answers at
  once. Otherwise it shows its window, saves what typing would have saved,
  and waits for those saves to finish. If something still cannot be saved (a
  failed or unconfirmed save, a plain editor's conflict, or the title of a
  new todo you have not added), the
  window lists it, names
  whether Epicenter is quitting or restarting, and offers "Keep working" or
  "Quit anyway" ("Restart anyway"). Nothing is added, retried, or discarded
  for you; leaving anyway only tells Epicenter this window is ready. A choice
  counts only for the quit or restart it was shown for.
- A Git command or terminal command already running when Epicenter asks is
  waited for. A pull or merge whose fetch finishes after the request applies
  nothing and says so. The terminal keeps its typed command, history, and
  output meanwhile, and Enter runs nothing; its typed command is not counted
  as unsaved.
- Todos opens its folder only once it is listening for a quit or restart and
  has read from Epicenter whether one is running. If it cannot listen, or
  cannot read that status, it shows "Todos is waiting for Epicenter" with
  Retry, and nothing is open or editable meanwhile; returning to the window,
  or a quit or restart beginning, also reads again.
- If the quit or restart is cancelled, by you or by another window, the
  page takes typing again with all unsaved input, failed saves, and typed
  titles as they were. Quitting again during the same quit asks the page again, without a
  second prompt. Until Epicenter says the quit is over, the page stays
  waiting, even if an answer to Epicenter was lost.
- A host restart after a crash, a forced kill, or a system shutdown that does
  not ask Epicenter ends the page without asking. Input that was not saved
  is lost. Nothing persists them. Saved files are on disk and reopen as they
  were.
- The browser demo has none of this: leaving the tab keeps its own leave
  warning.
- On quit, the Rust Folder owner fences new work, drains accepted local saves
  and commits, stops network work, and releases the directory lock. A forced
  kill can leave saved files uncommitted; the next commit includes them.
- A page reload or explicit client close ends that page's access. The shared
  owner remains open for sibling windows and finishes accepted work. The
  client's network wait can end while the native operation continues.
- A terminal command holds nothing between its steps. Other pages can save
  while it runs. A rewrite of a file the command read checks that captured
  version. Terminal writes make the same immediate automatic commit attempt
  as other saves. Git hashing and network traffic do not block saves.

### How it is wired

The Rust shell installs `tauri-plugin-epicenter-folder` once and registers the
Todos folder under the ID the page opens, `so.epicenter.todos`, with its
directory, author, remote, history policy, and allowed window label. Importing
the page's adapter acquires nothing; opening Todos calls `openFolder` from
`@epicenter/folder/tauri`, which attaches this page to that folder and sends
none of those settings.

```text
Todos window (WebView)
        | generated, typed Tauri invoke commands and change events
        v
shared Rust Folder plugin
        | canonical-root owner, file admission, Git queue, OS lock
        v
~/Epicenter/so.epicenter.todos
```

Rust reads and publishes bytes and owns Git history. Shared TypeScript code
interprets Markdown tables and runs the restricted terminal against that byte
boundary. Events announce changes; the page rereads through invoke. No file
contents or history are mirrored in browser storage on desktop.

Every page attached to the same root shares its owner. File admission orders
managed saves and terminal operations. A separate Git queue hashes a captured
file view after file admission is released, so a large file cannot hold up the
next save. Other programs do not participate in these queues; edits
made in place while capture is underway remain best effort.

The `epicenter-host` build condition selects the desktop leaf of
`#platform/folder`, and `vite.config.ts` resolves the bare `@epicenter/folder`
specifier to `@epicenter/folder/tauri` for that build, so it carries no
browser storage and no Git implementation. The browser build selects the
browser leaf and resolves the same specifier to `@epicenter/folder/browser`,
so it carries no desktop adapter. Both use the same UI and file interpretation.

## Browser demo

This build is for developing `@epicenter/folder` and the UI without the
desktop host. The folder and its Git history live in one directory of this
browser's origin private file system, `Epicenter/local/so.epicenter.todos`,
and a loopback Git server lets the browser push to a bare repository that an
ordinary native checkout pulls from and pushes to. The browser commits as
`Todos <todos@localhost>`. Another tab of the same origin edits the same
folder, and each tab rereads when the other saves.

A folder an earlier version of the demo kept in IndexedDB is not read, copied,
or deleted; this version starts from the OPFS directory alone.

From the repository root:

```sh
bun dev:todos
```

This starts the Git backend on `127.0.0.1:5187` and the UI on
`http://127.0.0.1:5186`, and prints the session: the bare repository, the
native checkout, and the remote URL. The UI reaches the backend same-origin
through the Vite proxy at `/git/todos.git`. `bun dev:todos:ui` starts the UI
alone; pushes and fetches then fail and say so, while saves and local commits
keep working. Set `TODOS_DEMO_ROOT` to a directory printed by an earlier run to
reopen it.

## Controls

Both builds share these. The todo list and its editor fill the window. The
header holds the rest:

| Control | What it does |
| --- | --- |
| Files button (Ctrl+B) | Shows or hides the file browser: a pane on wide screens, a drawer on narrow ones. |
| Folder path (desktop) | The directory the todos are in. Click to copy it. |
| Status button | Shows the most important current fact, shortened on narrow screens. Open it for where the folder is, saved files, uncommitted changes, the last commit, the remote, and the last pull as separate lines with the times they were observed, plus "Check again" and "Fetch". When the last remote check saw commits on both sides, it says the histories diverged; Todos only fast-forwards, so local commits are kept until the histories are resolved. |
| Pull | Fetches, then applies the remote only as a clean fast-forward. A refusal is shown as "Pull stopped" with the reason, and in the status details. Off when the folder has no remote. |
| Commit and push | Commits the saved files and pushes. Unsaved typing is not included. Reads "Commit" when the folder has no remote. |
| Recover incoming update | Shown only while an incoming update has not finished; see below. Pull, Merge incoming changes, and Commit and push are off until then, and say why. |
| Terminal button (Ctrl+\`) | Shows or hides the terminal. It is hidden at first; its output, history, typed command, and working directory stay when it is hidden. |

On narrow screens the list, the editor, and the terminal take turns; the
editor has a Back button, and the file browser opens as a drawer.

### When an incoming update stops partway

A pull or merge in the browser writes the incoming files one at a time. If it
stops partway (the tab closed, or a file could not be written), the folder
keeps a record of the update. Todos reports it under the header as "Incoming
update not finished" (or "never started", or "record unreadable"), and as the
first line of the status details. It never resumes the update on its own:
opening the folder, "Check again", and returning to the window only read the
record.

- Commits, pulls, and merges wait while the update is pending; their buttons
  are off and say why. Editing, saving, renaming, deleting, and Fetch keep
  working.
- **Recover incoming update** runs only when you press it. Open editors save
  their pending input first. If one has input it cannot save (a failed or
  unanswered save, or a plain editor's conflict), nothing runs and the button
  names those files. While the update runs, open todos take no typing, and
  plain editors keep your typing and hold their saves; afterwards each open
  todo reads its file again and shows what the update wrote, and a plain
  editor's typing saves against the version it read, so a file the update
  changed comes back as a conflict. Nothing is saved over the update.
- Recovery finishes the update from the files as they are: each file still at
  its version from before the update gets the incoming version, and each file
  already at the incoming version is left alone. A file that holds neither,
  such as one you edited after the update stopped, is named with the reason,
  nothing is written, and the update stays pending with its record. Make each
  named file hold one of its two versions (for example in its source, or
  with `git show` in the terminal), then press the button again.
- Nothing is discarded, rolled back, or retried for you.

Unsaved input lives only in this open page. Switching files keeps each
editor's input, but it is not stored anywhere else. In the browser, while
any editor has unsaved typing, a save in progress, a failed save, or a
conflict, reloading or closing the tab asks first with the browser's leave
warning. Leaving anyway discards that input; files already saved stay as
saved. The desktop window is covered under "Closing, quitting, and unsaved
typing" above.

## What to try

These steps are written for the browser demo, where a remote is always
present. On the desktop, steps 1 to 4 work the same over the real directory,
without the push.

1. Add a todo. The file saves immediately; a local commit follows in the
   background, and nothing is pushed until you press Commit and push. The
   status details report saved files, uncommitted changes,
   the last commit, and the remote separately. They say "Changes need
   checking" or "Check failed" instead of claiming a clean folder when the last
   observation is out of date or failed; focus and "Check again" check again.
2. Edit the title or notes. Each edit saves the todo's whole standard form
   at once: keys quoted, values in JSON spelling, keys Todos does not
   declare kept. A key you remove in the source is removed from the file.
   The **Source** tab edits the file's exact text through the
   same todo; it stays in Source after repair until you choose **Notes** or **Edit fields**. Saves
   of one todo run one at a time, and the latest edit follows the save that
   is running. The todo does not follow changes made elsewhere: **Reload**
   reads the file and shows it, and otherwise your next edit writes over
   them. A save that fails keeps your input and its error visible, including while
   a newer save runs, until a save or reload succeeds. The latest
   waiting edit proceeds, and later typing saves again. "Try again" saves
   the current text; "Discard mine and reload" replaces it with the file.
   Trying again sends exactly the text the todo holds, comments and quoting
   included. Discarding writes nothing and shows the file as it is now. A
   save whose reply was lost says it may or may not be in the file, with the
   folder's own detail, and offers "Save again". A todo whose file was
   removed says so and offers "Close"; nothing recreates it. A title or notes
   value the file cannot hold, such as text with a lone surrogate, stays in
   its field with the reason while the rest of the todo keeps saving;
   leaving, rename, delete, and quitting count it as unsaved until you fix it
   or choose "Discard mine and reload".
3. Open the file browser. Folders expand and collapse; a todo file opens its
   todo editor, and any other text file opens in a plain editor whose saves
   land only if the file is still the version it read; a save that races
   another writer offers "Save mine over it" or "Discard mine and load
   saved". File saves request
   automatic history without waiting for Git. A file that is not UTF-8 text,
   or is over 1 MB, shows its type and size and is never saved as text.
   Right-click a row, or use its "…" button, for Open, Rename, Copy path, and
   Delete; on a folder, New file and New folder. With a row focused, arrow
   keys move and expand, F2 renames, Delete asks to delete, and Shift+F10
   opens the menu.
   - Renaming or deleting a todo file changes that one Markdown file. A file
     with the same stem, such as an image or a recording, stays where it is.
     Any file is renamed or deleted only if it still has the version you saw.
   - Rename and delete wait for the file's saves first, and refuse while its
     editor has input that could not be saved; the input stays in the editor.
     A todo takes no typing while it is being renamed or deleted, and opens
     again at its new name. A plain editor keeps typing during a rename and
     saves it at the new name once the rename finishes.
   - A rename onto a file that is open in an editor is refused, and so is a
     second change to a file while one is still in progress.
   - Delete always asks first, naming what it removes. Only empty folders can
     be deleted from the browser. Renaming does not update references to the
     old name in other files.
4. In the terminal: `ls todos`, `cat todos/<stem>.md`, `echo '...' > note.md`,
   `git status`, `git log --oneline`, `git diff`, `git push`. Content writes
   request automatic history; staged authoring is refused in automatic mode.
   Files matched by `.gitignore` stay out of status and automatic commits; a
   tracked file stays tracked. A later automatic commit or Commit and push
   resets staged-only changes to the committed state.
5. In the native checkout printed at startup:

   ```sh
   git pull --ff-only
   $EDITOR todos/<stem>.md
   git commit -am "Edit natively" && git push
   ```

   Then press **Pull** in the browser. Pull applies only a clean fast-forward;
   uncommitted changes, divergent history, or an incoming file that would
   overwrite an ignored or untracked one are reported and nothing is written.
6. To see a hand edit from another computer, run the demo fixture against the
   same checkout:

   ```sh
   bun apps/todos/scripts/remote-edit.ts <checkout> <stem> "Buy oat milk"
   ```

   It pulls, rewrites `todos/<stem>.md` with a YAML comment, a new title,
   `done: true`, and the keys `owner` and `labels`, which Todos does not
   declare, then commits and pushes with ordinary Git. Press **Pull** in the
   browser: the list shows the new title, an open todo shows it after
   **Reload**, and the file keeps the comment and keys byte for byte.
   Checking the todo off in the list while it is not open changes only its
   `done` value and keeps every other byte. Saving it from its open editor
   writes its standard form, which keeps `owner` and `labels`. While the todo
   is open, the list's checkbox is a change to its editor and saves the same
   way, with its latest title and notes, after any save already running; it
   changes nothing while that todo is edited as source. A failed save does
   not block the next checkbox change.
7. `bun apps/todos/scripts/native.ts <checkout> status` prints the native
   folder's JSON status through `openFolder` from `@epicenter/folder/bun`.
   `create "<title>"`, `complete <stem>`, `commit-and-push`, `fetch`, and
   `pull` are also available. A checkout that cannot be opened prints the
   refusal and exits 1.

Write a file whose text does not parse (for example `printf -- '---\ntitle: *missing\n---\n' > todos/bad.md`,
or Markdown with no `---` lines at all) to see a row marked "Needs repair". It
is still a todo you can select. It opens in its source, with no title, done,
or notes controls, and says why; you fix it there. Saving text that still
does not parse succeeds and keeps it marked. A todo that parses but has a bad
field, such as `done: soon`, opens the same way. Once the text reads as a
todo, **Edit fields** shows its controls again. The messages shown describe
the text on screen. An open todo whose file becomes unreadable elsewhere keeps
its controls and your input: **Reload** says why it could not read the file
and changes nothing, and your next edit, or "Try again" after a failed save,
writes your text over whatever the file holds. A todo file whose editor does
not open is shown as that failure, never as a plain text editor; opening it
again retries.

Any file name works for a todo, including a leading dot, a trailing space,
punctuation, and `todos/.md` itself. Only `.md` in lowercase makes a file a
todo; `todos/a.MD` is an ordinary file.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineFolder` declaration, written with the shared `defineTable` and `field` vocabulary. It names no folder. |
| `src/lib/open-todos-page.ts` | How the mounted page opens its Todos owner: inside Epicenter only after a departure status is known, attached the moment it exists. |
| `src/lib/departure.svelte.ts` | This page's answer when Epicenter asks to quit or restart: listens first, applies statuses in version order, fences the Todos owner, asks it to save, and answers or asks the person. It discards nothing. |
| `src/lib/platform/` | The `#platform/departure` seam: the host leaf talks to this window over the departure wire and Tauri; the browser leaf has no port. And the `#platform/folder` seam: `types.ts` is its contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens the OPFS folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the host's directory through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The mounted page calls it; importing it opens nothing. |
| `src/lib/editor.svelte.ts` | The plain editor for any text file that is not a todo, with conditional saves and their conflict choice. |
| `src/lib/todo-editor.svelte.ts` | The todo editor: one retained native row editor (`table.edit`) for a todo's fields and source, which every edit replaces whole at once; the source preference; and the fences that rename, delete, recovery, close, and a departure put on input. |
| `src/lib/files.ts` | File browser rows, and which files open as editable text. |
| `src/lib/todos.svelte.ts` | Todo and folder listings, path selection, retained editors, and file actions. |
| `src/lib/terminal.svelte.ts` | The terminal session that outlives the terminal pane, over the folder's own `folder.terminal()`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, file browser, list, editors, and terminal. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `scripts/dev.ts` | Starts the backend and Vite together. |
| `scripts/native.ts` | JSON CLI over the native checkout. |
| `scripts/remote-edit.ts` | Demo fixture: a hand edit with undeclared frontmatter, committed and pushed from the native checkout with ordinary Git. |
| `scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares, for the seam test. |

`TodoDetail` is one view reused as the selection moves between todos, and
each todo's input lives in its retained editor, not in the view. The editor
exposes its current `row` and `save` state, and takes a whole row through
`todo.set(next)`. Each field's function binding reads the current todo on
every call: the getter shows the row's field; the setter composes the
complete row from `todo.row` with the new value, such as
`todo.set({ ...row, fields: { ...row.fields, title } })`. The notes setter
restores the file's line endings itself, since the textarea reports LF. A row
the editor cannot take (a lone surrogate has no form in a file) changes
nothing: the control shows the row's value again, and the editor keeps only
why, as `todo.refusal`, beside the save state until input is taken or a
reload succeeds. It is not unsaved input. Svelte evaluates a function binding's expressions once, when the block is
created, so a binding that captured one todo would keep showing and writing
it after the selection moves. A view can also leave while its todo stays
retained, as on narrow screens, and a node that left the document keeps its
input and submit listeners; `TodoDetail`, `TodoStatus`, and `FileNameBar`
therefore act only while mounted, and the editor refuses a row unless it
still shows its fields and takes input. An editor the owner released refuses
input and commands for good.

Checks: `bun run --cwd apps/todos typecheck` (both seam leaves and the Bun
side), `bun run --cwd apps/todos test` (it builds the Folder's file exchange
addon that the native harness needs, runs the tests on Svelte's server
runtime, then `test:mounted`: the real `TodoDetail` mounted in jsdom under
`--conditions=browser`), `bun run --cwd apps/todos build` for
the browser demo, and `bun run --cwd apps/todos build:epicenter` for the build
Epicenter serves. The two builds share SvelteKit's output directory, so run
them one after the other.
