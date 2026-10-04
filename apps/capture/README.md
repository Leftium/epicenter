# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data, and Git records their history. There is no account and no
sign-in on this path. The file format and its rules are in
[`packages/capture`](../../packages/capture/README.md).

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory, owned by the Epicenter desktop shell. | Real Git in that directory's `.git`, recorded by the shell. No remote. |
| Browser | One directory in this browser's origin private file system (OPFS), `Epicenter/local/so.epicenter.capture`. | Git in that directory's `.git`, in OPFS beside the files. No remote. |

The browser opens the OPFS directory alone. It does not read, copy, or delete
a folder an earlier version kept in IndexedDB.

Run the browser build with `bun dev:capture` (or `bun dev:capture:ui`) from
the repository root. It starts the app and nothing else. Start `bun dev:api`
yourself only to export old captures from a hosted account, described below.

## What you can do

- **New capture** saves the text exactly as written, with an empty Thoughts
  section. The file is named for the time, `captures/20261001-023000-ab12c.md`.
  Ctrl or ⌘ + Enter adds it, and the new capture opens with the cursor in
  Add a thought. Closing the form keeps its text.
- Open a capture to edit its text, and to add, edit, reorder, copy, and delete
  thoughts. A thought can span lines and hold nested Markdown. Add a thought
  sits after the last thought, which is where a new one goes; Ctrl or ⌘ +
  Enter adds it. Each thought's Actions menu holds Edit, Move up, Move down, Copy
  text, and Delete.
- **Source** is the tab beside Capture. It names the file, shows it exactly,
  and edits it directly. Anything Markdown allows can go there, and the
  Capture view follows it.
- **More** holds Copy source, Download file, and **Delete capture**. Deleting
  shows the saved file as it is now and deletes exactly that file. If it
  changed since you reviewed it, it asks you to review again.

Moving a thought to another capture has no control. Cut it from one capture
and paste it into the other; each is its own file and its own save.

When a file's layout is ambiguous (two "Thoughts" headings, text between the
heading and the list, two lists), the Capture view says why and offers
Source. Nothing is rewritten to make it fit.

## Saving

Typing saves on its own after a short pause. The header shows the state, and
shows it in red when saving is stopped or was not confirmed.

- An open capture is edited through the folder's row editor. A save writes
  the whole capture over the file: its frontmatter in the standard form
  (keys quoted, values in JSON spelling, keys Capture does not declare kept)
  and its text and thoughts exactly. It does not check what the file holds;
  the window checks that by reading, below. Typing during a save stays
  unsaved and saves next.
- Opening, selecting, and listing captures write nothing.
- **If the file changes outside this window** and you have nothing unsaved,
  the window shows the new file. If you do have unsaved text, your text stays,
  saving pauses, and the saved file is shown beside these choices:

  | The saved file | Choices |
  | --- | --- |
  | Changed | Load saved (discard my draft). Save my draft over this version. Save my draft as a copy. Download my draft. |
  | Changed into text that is not a valid capture | Repair the saved file in Source (discard my draft). Save my draft over it. Save as a copy. Download. |
  | Cannot be read | Check again. Save as a copy. Download. It cannot be overwritten, because it cannot be reviewed. |

  A capture removed outside this window is written back by its next save.
  "Save my draft over this version" replaces whatever the file holds when the
  save lands, including a change made after you looked.
- **If a save cannot be confirmed**, the notice puts the choices first and
  keeps the exact failure under "Show technical details". Your text stays: Try again, Save as a
  copy, Download, or Discard my changes. The window does not claim the file is
  unchanged, because a write can reach the disk and its answer still be lost.
  Try again sends the capture again; a later read that finds your text says
  what the file holds, not that the earlier save landed.
- **Source** holds the file's exact text. A Source edit that changes only the
  text and thoughts goes back through the row editor; one that changes the
  frontmatter, or a file that cannot open as a capture, is saved as exact
  text and only over the version you were shown.
- **Save as a copy** saves the capture as it is in Source. It is refused
  while you have typed text that is not in the source yet (a new thought, a
  thought you are editing, capture text that could not be applied), because
  letting go of the draft would drop that text. Add it or clear it first.
- A capture whose file was removed stays on the timeline, marked, for as long
  as this window holds text for it.
- **Git is separate.** A file that saved is saved. If the commit that records
  it fails, a "History was not recorded" notice says so and offers the commit
  again, with Git's own message under "Show technical details". It never undoes a save.

## Unsaved text is protected

Unsaved text lives only in the open window: edits that have not saved yet,
text in the New capture form, text in Add a thought, a thought being edited,
and capture text that could not be applied. Any typed character counts,
spaces included, until you add it or clear it.

- Moving between captures and the timeline keeps all of it.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists. The reload shortcut is refused with a message.
- On the desktop, closing the Capture window hides it; the page and its text
  stay loaded. Using the Quit menu or Cmd-Q asks the window first. It waits
  for actions already in progress and for every saveable draft. If everything
  saves, it quits. Otherwise it offers **Keep working** or **Discard and quit**.
- If Epicenter closes the folder, the window says saving cannot be
  confirmed. Your text stays so you can copy or download it, and reloads are
  held back.
- If Epicenter's background service stops, the window says so. Saving does
  not depend on that service and carries on; reloading the window may not
  work until Epicenter restarts.

Nothing persists unsaved text across a reload or a quit you confirm.

## Captures from before this version

Earlier versions kept captures in your Epicenter account, not in files. The
timeline's "Bring in captures from before this version…" link opens a screen
that copies them in. Nothing on it runs unless you press a button, and the
old data is only read.

1. **Get an export.** Either choose an export file (JSON) saved earlier, or
   use your account: sign in, then export. The export holds what this device
   has for your account. A device that has not finished syncing has less than
   the account; export again later to pick up the rest.
2. **Import.** Each old capture becomes one Markdown file with its thoughts
   in order and its original date. Earlier entries become their own files.
   Thoughts whose capture is missing are kept in a recovery file that says so.
   Anything that could not be read is listed in a report in `recovery/`.

Importing the same export twice adds nothing twice, and nothing is
overwritten. The exact rules, including what happens after you delete an
imported capture, are in the
[package README](../../packages/capture/README.md#importing-the-old-store).

`fixtures/legacy-bundle.json` is an export file for trying this without
signing in.

## Desktop, inside Epicenter

The captures are files in `so.epicenter.capture/captures` under Epicenter's
working-copy directory (`~/Epicenter/so.epicenter.capture` in production).
The timeline shows the directory. Edit the files with any program: Capture
rereads when the shell reports a change, every 30 seconds while the window is
visible, and when the window regains focus.

The Epicenter desktop shell owns that directory, through the shared folder
plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md).
Its README states what the owner promises and what it does not. What that
means for Capture:

- One Epicenter owns the directory at a time, through a lock file beside it,
  `.so.epicenter.capture.epicenter-lock`. A second one is refused with a
  message naming the directory.
- Other programs are not asked to take the lock. An open capture's save
  replaces the whole file; the window learns of another program's edit only
  by reading, so an edit that lands between that read and the save is
  overwritten. A repair in Source, a copy, and an import name the version the
  window read, and the owner refuses them if the file is no longer that
  version; an edit in the instant between the owner's last check and its
  replacement of the file is still overwritten. Neither is an
  operating-system compare-and-swap.
- The owner watches the directory and also rechecks it on a timer, so a
  change the operating system did not report is still announced. A change
  announced to the window is a hint to reread. It never carries file contents
  and never replaces text you have typed.
- The owner makes one commit attempt after each save, whether or not a
  Capture window is still open. An attempt that finds Git busy is skipped,
  and the save stays uncommitted until a later save or an explicit commit.
  The window schedules no commits.
- History is local-only. The shell registers the Capture folder to take the
  commit author from the directory's Git config when one is set there
  (otherwise `Capture <capture@localhost>`), to ignore that config's
  `origin`, and with no remote. So nothing is fetched or pushed, whatever
  remote the directory names. Capture has no control that fetches, pulls, or
  pushes. The policy in effect is on the folder's Git snapshot.
- The owner refuses a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule).

### How it is wired

```text
Capture window (WebView)
   openFolder({ id, definition })  from @epicenter/folder/tauri
        |  Tauri invoke: plugin:epicenter-folder|attach, read, apply, commit, ...
        |  Tauri events: folder-files-changed, folder-snapshot-changed
        v
Epicenter shell (Rust)  ->  tauri-plugin-epicenter-folder  ->  <directory>
```

The page names the folder by its ID, `so.epicenter.capture`
(`CAPTURE_FOLDER_ID` in `src/lib/platform/types.ts`), and nothing else. The
shell registered that ID with its directory, its history policy, and
the windows that may use it, so a page cannot ask for an arbitrary path or
choose an author or a remote. There is no HTTP route and no Bun process
between the window and its files.

`src/lib/platform/folder.epicenter-host.ts` is the whole desktop leaf. It
calls `openFolder` from `@epicenter/folder/tauri`, which opens the shell's
folder or returns why it cannot, and hands the folder to the same collection
and draft code the browser build uses. The browser leaf calls `openFolder`
from `@epicenter/folder/browser` and states its own history policy: a local
author, a commit after each save, and no remote. Each entry refuses in the
other environment. `vite.config.ts` points the bare `@epicenter/folder`
specifier, which `@epicenter/capture` imports, at the same entry, so a build
emits one adapter.

Capture uses the folder's captures table, including `edit`, whose row editor
overwrites the whole file on each save, and `replace` and `delete`, which act
only on the version that was read; the Git snapshot and commit; and three
file verbs for copies and imports under `captures/*.md` and `recovery/*`:
`read`, `create` (refused when anything is at the path), and `replace`
(refused unless the file is still the exact one that was read). It takes no
raw verb that overwrites. That surface is the `CaptureFolder` type in
`src/lib/platform/types.ts`. The plugin
grants an authorized Capture window the whole Capture directory and nothing
outside it; there is no per-call allowlist.

Capture opens no terminal. A folder loads its terminal with a dynamic
import, so each build emits that chunk, and the page never requests or runs
it.

The build Epicenter serves is selected by the `epicenter-host` condition on
`#platform/folder`. That leaf opens no browser folder, so it cannot fall back
to browser storage. Outside the shell, in a window the folder does not allow, with no
folder registered, or with no plugin installed, opening fails and the page
shows the reason.

### What closing and stopping mean

| Event | What happens |
| --- | --- |
| The page is destroyed or reloaded | `captures.close()` finishes the page's create, import, copy, delete, and draft saves before `host.close()` stops the quit listeners and change hints and detaches this page's session. Teardown does not overwrite failed or conflicted drafts. An explicit discard cancels later draft saves while waiting for saves already submitted. The folder stays open in the shell for its other windows. |
| The Capture window is closed | The shell hides it. The page, its session, and its drafts stay loaded. |
| The shell closes the folder | The folder's Git snapshot arrives with `closed`. The window says saving cannot be confirmed, keeps every draft, and holds reloads back. |
| Epicenter's Bun service stops (`capture-host-stopped`) | A notice. The folder is the shell's, so saving carries on. The service served this page, so a reload may fail until Epicenter restarts. |
| A reply to a save is lost | The draft is kept and marked not confirmed. Try again sends the capture again; a read that finds the text says what the file holds, not that the save landed. Nothing is sent twice automatically. |

### Quitting

The Rust shell owns the quit handshake in
`apps/epicenter/src-tauri/src/capture_lifetime.rs`. It accepts answers only
from the Capture window for the current request. If the page does not
acknowledge the request, a native dialog requires an explicit choice before
discarding its text.

The handshake covers the Quit menu item and Cmd-Q, and nothing else. Dock
Quit, an operating-system termination request, a forced termination, and the
shell's own process restart bypass it, and unsaved text in the window is lost.

The page side is in `src/lib/platform/shell-lifetime.ts`:

| Shell to page | Page to shell |
| --- | --- |
| Event `capture-quit-requested`, payload: a numeric request ID | `invoke('capture_quit_answer', { requestId, answer: 'asking' })` at once, then exactly one of `'proceed'` or `'cancel'` |
| Event `capture-host-stopped` | None. The page shows the notice above. |

A request that arrives before the page is listening is acknowledged and
answered once it is. If the window cannot listen for quit requests, the page
says so in a notice instead of quitting unprotected in silence. If the
listeners cannot be set up at all, the page detaches the session it attached
and shows the failure.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` attaches to the shell's directory, and `shell-lifetime.ts` is the quit protocol. `auth.*.ts` is used only by the old-data export. |
| `src/lib/draft.svelte.ts` | One open capture: its row editor or, for a file that cannot open as a row or a frontmatter edit in Source, its exact text; autosave, conflict choices, and unsent input. |
| `src/lib/captures.svelte.ts` | The listing, the open drafts, and completion of create, import, copy, delete, and draft saves. |
| `src/lib/recovery/` | Opens the old account store for an export. Loaded only from the recovery screen. |
| `src/lib/components/` | The timeline, a capture, the conflict choices, and the recovery screen, composed from `@epicenter/ui`. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun test packages/capture apps/capture
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # both seam leaves and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:epicenter  # the build Epicenter serves
bun scripts/check-ui-boundary.ts
```

The two builds share SvelteKit's output directory, so run them one after the
other.

| Test | What it checks |
| --- | --- |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real folder adapter, with the shell's `invoke` and events scripted: refusals fail the open, closing detaches once, the collection keeps a draft through a conflict, a lost reply, and an outside change, and an import interrupted by a lost reply is finished by a retry. It does not run the Rust owner. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter, generated bindings, or quit protocol. |
| `src/lib/captures.test.ts`, `src/lib/draft.test.ts` | The collection and the draft over a real directory and a recorded store. |

The Rust owner, its watcher, its lock, and its history are tested in
`packages/tauri-plugin-epicenter-folder` and in
`packages/folder/src/tauri-native.test.ts`. The desktop window itself is
checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit and tab keys, source editing, reload, outside changes, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | A standalone tool, not the desktop backend: imports a bundle into a real directory twice, through `@epicenter/folder/bun` with an explicit author and no remote, and prints both reports. Exits nonzero if the retry creates anything. |
