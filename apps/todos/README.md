# Todos

A file-first todo list. Each todo is a plain Markdown file, `todos/<stem>.md`,
with `title` and `done` in frontmatter and notes in the body. A file browser
shows every file in the folder, and a terminal edits the same files and runs
Git commands against the folder's history.

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory on this computer, opened by the Epicenter host. | Real Git in that directory's `.git`. No remote unless you add one. |
| Browser demo | A folder in this browser's IndexedDB. | Git objects in IndexedDB, with a loopback remote for the demo. |

Todos uses no hosted API, account, or secrets in either build. It is built on
`@epicenter/folder` and does not depend on `@epicenter/app`. A folder that
cannot be opened is shown as that refusal. The desktop build never falls back
to browser storage.

A todo is its Markdown file and nothing else. A file that shares a todo's stem,
such as `todos/milk.png` or `todos/milk.webm` beside `todos/milk.md`, is an
ordinary file: renaming or deleting the todo leaves it where it is, and you
rename or delete it yourself from the file browser.


## Storage and editor migration

The selected migration uses one scoped OPFS directory for browser files and
`.git/`, individual file operations, and the folder's canonical table editor.
The app owns editor retention and autosave; unsupported source remains available
for raw repair. Structured saves replace the complete document and rewrite
frontmatter formatting. An unknown reply stays unknown in save history even
when a later read finds the desired content. Incoming Git adoption retains its
own recovery record and refuses mixed checkpoints until explicit recovery.

Integration and UI verification are pending. Sections describing IndexedDB,
app-owned editor engines or older recovery controls document the implementation
before this migration. The decisions are recorded in
[ADR-0497](../../docs/adr/0497-browser-folders-use-scoped-opfs-directories.md),
[ADR-0482](../../docs/adr/0482-folder-mutations-publish-one-file-at-a-time.md), and
[ADR-0483](../../docs/adr/0483-honeycrisp-shares-one-canonical-editor-per-open-row.md).

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
A reread never replaces what you have typed: a clean editor adopts the new
text, and an editor with unsaved typing keeps it and reports a conflict at its
next save.

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
  take it. A save checks that the file still has the version the editor read,
  and checks again after staging the new bytes, immediately before replacing
  the file. An edit that lands in the instant between that last check and the
  replacement is overwritten. This is a best-effort check, not an
  operating-system compare-and-swap, and nothing merges.
- A rename or delete of a todo changes one file, its Markdown file. A failure
  is reported as it happened: a refusal wrote nothing, and a reply that never
  arrived says the change may have landed. Nothing is retried or rolled back.
- Todos refuses to open a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule), or whose
  `.git/epicenter/scratch` is linked elsewhere. It checks this when it opens
  the directory; it does not defend against a program that swaps a link in
  while it runs. Symbolic links among the files are not followed.
- Git commands Epicenter runs ignore inherited `GIT_DIR`, `GIT_WORK_TREE`, and
  `GIT_INDEX_FILE`, and never fall through to a repository in a parent
  directory.

### Closing, quitting, and unsaved typing

Unsaved typing lives only in the open window. Typing saves on its own after a
short pause, so the cases below are about input that could not be saved: a
conflict, a failed save, or text typed in the last moment.

- Closing the Todos window hides it. The page stays loaded, so drafts and the
  terminal's output are still there when you open Todos again.
- Quitting Epicenter, restarting it, a host restart after a crash, and
  Epicenter's account reset all end the page. Drafts that were not saved are
  lost, including a conflict you had not resolved. Nothing persists them.
  Saved files are on disk and reopen as they were.
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
contents or history are mirrored in IndexedDB on desktop.

Every page attached to the same root shares its owner. File admission orders
managed saves and terminal operations. A separate Git queue hashes a captured
file view after file admission is released, so a large file cannot hold up the
next save. Other programs do not participate in these queues; edits
made in place while capture is underway remain best effort.

The `epicenter-host` build condition selects the desktop leaf of
`#platform/folder`, and `vite.config.ts` resolves the bare `@epicenter/folder`
specifier to `@epicenter/folder/tauri` for that build, so it carries no
IndexedDB storage and no Git implementation. The browser build selects the
IndexedDB leaf and resolves the same specifier to `@epicenter/folder/browser`,
so it carries no desktop adapter. Both use the same UI and file interpretation.

## Browser demo

This build is for developing `@epicenter/folder` and the UI without the
desktop host. The folder and its Git history live in this browser's IndexedDB,
and a loopback Git server lets the browser push to a bare repository that an
ordinary native checkout pulls from and pushes to. The browser commits as
`Todos <todos@localhost>`. Another tab of the same origin edits the same
folder, and each tab rereads when the other saves.

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
| Terminal button (Ctrl+\`) | Shows or hides the terminal. It is hidden at first; its output, history, typed command, and working directory stay when it is hidden. |

On narrow screens the list, the editor, and the terminal take turns; the
editor has a Back button, and the file browser opens as a drawer.

Unsaved input lives only in this open page. Switching files keeps each
editor's draft, but drafts are not stored anywhere else. In the browser, while
any editor has unsaved typing, a save in progress, a failed save, or a
conflict, reloading or closing the tab asks first with the browser's leave
warning. Leaving anyway discards that input; files already saved stay as
saved. The desktop window is covered under "Closing, quitting, and unsaved
typing" above.

## What to try

These steps are written for the browser demo, where a remote is always
present. On the desktop, steps 1 to 4 work the same over the real directory,
without the push.

1. Add a todo. The file saves immediately; a commit follows in the background,
   then a push. The status details report saved files, uncommitted changes,
   the last commit, and the remote separately. They say "Changes need
   checking" or "Check failed" instead of claiming a clean folder when the last
   observation is out of date or failed; focus and "Check again" check again.
2. Edit the title, notes, or raw source. Typing stays in the editor until its
   save; a save that races another writer stops and offers "Discard mine and
   load saved" or "Save mine over it". A save that fails offers "Try again"
   and "Discard mine"; only that choice drops the typing, and it writes
   nothing.
3. Open the file browser. Folders expand and collapse; a todo file opens its
   todo editor, and any other text file opens in a plain editor with the same
   save and conflict rules. File saves request automatic history without waiting
   for Git. A file that is not UTF-8 text,
   or is over 1 MB, shows its type and size and is never saved as text.
   Right-click a row, or use its "…" button, for Open, Rename, Copy path, and
   Delete; on a folder, New file and New folder. With a row focused, arrow
   keys move and expand, F2 renames, Delete asks to delete, and Shift+F10
   opens the menu.
   - Renaming or deleting a todo file changes that one Markdown file. A file
     with the same stem, such as an image or a recording, stays where it is.
     Any file is renamed or deleted only if it still has the version you saw.
   - Rename and delete refuse while the file's editor has input that cannot be
     saved, and the input stays in the editor. Typing during a rename is kept
     and saves at the new name once the rename finishes.
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
6. `bun apps/todos/scripts/native.ts <checkout> status` prints the native
   folder's JSON status through `openFolder` from `@epicenter/folder/bun`.
   `create "<title>"`, `complete <stem>`, `commit-and-push`, `fetch`, and
   `pull` are also available. A checkout that cannot be opened prints the
   refusal and exits 1.

Write a file whose text does not parse (for example `printf -- '---\ntitle: *missing\n---\n' > todos/bad.md`,
or Markdown with no `---` lines at all) to see a row marked "Needs repair". It
is still a todo you can select: its title, done, and notes controls are
disabled, structured edits are refused, and you fix it in the Source tab.
Saving text that still does not parse succeeds and keeps it marked. A todo
that parses but has a bad field, such as `done: soon`, is marked the same way
and keeps its other controls working. The messages shown describe the text on
screen, saved or not.

Any file name works for a todo, including a leading dot, a trailing space,
punctuation, and `todos/.md` itself. Only `.md` in lowercase makes a file a
todo; `todos/a.MD` is an ordinary file.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/definition.ts` | The inert `defineFolder` declaration, written with the shared `defineTable` and `field` vocabulary. It names no folder. |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract and holds `TODOS_FOLDER_ID`, `folder.browser.ts` opens the IndexedDB folder through `@epicenter/folder/browser`, and `folder.epicenter-host.ts` opens the host's directory through `@epicenter/folder/tauri`. Each returns the folder or the refusal. The mounted page calls it; importing it opens nothing. |
| `src/lib/editor.svelte.ts` | One draft's buffer, baseline, save queue, and conflict choice, shared by todo and raw text editors. |
| `src/lib/files.ts` | File browser rows, and which files open as editable text. |
| `src/lib/todos.svelte.ts` | Todo and folder listings, path selection, retained editors, and file actions. |
| `src/lib/terminal.svelte.ts` | The terminal session that outlives the terminal pane, over the folder's own `folder.terminal()`. |
| `src/lib/status.ts` | Plain-language status lines and the header summary. |
| `src/routes/components/` | Header, file browser, list, editors, and terminal. |
| `server/git-server.ts` | `git http-backend` over a bare repository, plus the native checkout. |
| `scripts/dev.ts` | Starts the backend and Vite together. |
| `scripts/native.ts` | JSON CLI over the native checkout. |
| `scripts/module-graph.ts` | Lists the modules a build of one entry pulls in, resolved with the conditions and aliases `vite.config.ts` declares, for the seam test. |

Checks: `bun run --cwd apps/todos typecheck` (both seam leaves and the Bun
side), `bun run --cwd apps/todos test`, `bun run --cwd apps/todos build` for
the browser demo, and `bun run --cwd apps/todos build:epicenter` for the build
Epicenter serves. The two builds share SvelteKit's output directory, so run
them one after the other.
