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
  Capture view follows it. Which tab is shown is only a view choice; it
  changes nothing saved.
- **More** holds Copy source, Download file, Reload from file, and **Delete
  capture**. Deleting first waits for saves already sent, then shows the
  saved file as it is now and deletes exactly that file, without reading it
  again. If it
  changed since you reviewed it, nothing is deleted and the file as it is
  now is shown for another review. The review stays open until you delete or
  cancel, even if you move to another capture and back. Nothing is deleted
  while Epicenter is quitting or the window is closing; a delete already sent
  finishes first.

Moving a thought to another capture has no control. Cut it from one capture
and paste it into the other; each is its own file and its own save.

When a file's layout is ambiguous (two "Thoughts" headings, text between the
heading and the list, two lists), the Capture view says why and offers
Source. Nothing is rewritten to make it fit.

## The editor and its views

Source and Capture share the editor acquired for the open file. Source binds
its complete text. Capture decodes only its Markdown body as `{ text, thoughts }`
and composes a complete desired value. The body codec reconstructs and checks
that value, then the draft calls `editor.set({ ...editor.row, body })`.
Thoughts are strings selected by position. A changed list uses consistent bullet
formatting and preserves surrounding Markdown. A delayed edit or confirmation
checks that its starting list is still current. Both views share the same save
queue.

The draft keeps text that a structured edit cannot represent. The editor keeps
accepted text even when publication fails. A row with invalid fields or
frontmatter, or a body with ambiguous Thoughts markup, opens Source with the
reason visible. Repair leaves Source selected. Shared Tabs unmount inactive
panels; shared Textarea stops retired controls from reading or delivering input.
The draft keeps its single view selection above those panels.

## Saving

Every change saves at once. The header shows the state, and shows it in red
when saving is stopped or was not confirmed.

- An open capture is edited through the folder's row editor, acquired once
  per open file and kept for the Capture view and Source alike. Each change
  is a complete replacement of the existing file. A change in the Capture
  view writes the frontmatter in the standard form (keys quoted, values in
  JSON spelling, keys Capture does not declare kept) and the text and
  thoughts exactly. A Source edit writes exactly what is typed, frontmatter
  and malformed text included. One save is sent at a time; the latest text
  goes next.
- **The latest save wins.** An open capture loads its file once. A change
  made outside this window is not shown until you choose Reload from file,
  and the next save from this window replaces it. Listing, focus, and change
  hints refresh the timeline only; they never replace what an open capture
  shows.
- A save never creates a file. A capture removed outside this window is not
  written back by saving; see below.
- Opening, selecting, and listing captures write nothing.
- **If a save fails or cannot be confirmed**, your text and the error
  stay visible until a newer save succeeds or a reload succeeds.
  The latest waiting edit proceeds after the failure, and
  later typing starts another save. Try again saves the current text. An unconfirmed save shows the
  exact report, which names where a file it displaced was kept when there
  was one; a failure keeps its report under "Show technical details". The
  window does not claim the file is unchanged, because a write can reach the
  disk and its answer still be lost. The choices:

  | The failure | Choices |
  | --- | --- |
  | Failed or not confirmed | Try again. Save my text as a copy. Download my text. Discard my changes. |
  | The file was removed | Put the file back. Try again. Save as a copy. Download. Let it go. |

  Try again sends your newest text over whatever the file holds then.
  Discard my changes reloads the file as it is now and drops your text.
  "Put the file back" creates the file from your text exactly; if a file is
  there again instead, nothing is written, and Try again is the way to write
  over it. Let it go closes the capture without writing.
- **Reload from file** waits for a save being sent, then reads the file and
  shows it. If it cannot be read, your text and any failure stay. If you type
  while it reads, your typing stays and nothing is loaded. If the file is
  gone, the window says so and offers Put the file back, Save as a copy,
  Download, Check again, and Let it go.
- **A file that is not a valid capture** opens in Source with the reason. It
  saves as you type it, so you can repair it there; the Capture view returns
  once it is a valid capture.
- **Save as a copy** saves the capture as it is in Source, as a new file that
  must not exist yet, and leaves the original as it is. It is refused while
  you have typed text that is not in the source yet (a new thought, a thought
  you are editing, capture text that could not be applied), because letting
  go of the capture would drop that text. Add it or clear it first.
- A copy and putting a file back write your text exactly or not at all. Text
  with a character a file cannot hold exactly (a lone surrogate) is refused
  before anything is written, and stays here to change or to copy out.
- Copying text out and downloading it change nothing, so they stay open
  while Epicenter is asking about quitting.
- **If a delete is not confirmed**, the file may or may not be gone. Typing
  for that file is kept and not saved until you choose: Keep it as the file
  is now, Keep it: put the file back, Save my text as a copy, Download, or
  Let it go.
- A capture whose file was removed stays on the timeline, marked, for as long
  as this window holds text for it that is not saved.
- Where the platform has no way to replace a file that requires it to still
  be there (Windows, for the desktop owner and a Bun directory), a save fails
  as an I/O error and your text stays; see
  [the folder package](../../packages/folder/README.md#files).
- **Git is separate.** A file that saved is saved. If the commit that records
  it fails, a "History was not recorded" notice says so and offers the commit
  again, with Git's own message under "Show technical details". It never undoes a save.

## Unsaved text is protected

Unsaved text lives only in the open window: a save still being sent or one
that failed, text in the New capture form, text in Add a thought, a thought being edited,
and capture text that could not be applied. Any typed character counts,
spaces included, until you add it or clear it.

- Moving between captures and the timeline keeps all of it.
- Reloading, closing the tab, or leaving the app asks first while any of it
  exists. The reload shortcut is refused with a message.
- On the desktop, closing the Capture window hides it; the page and its text
  stay loaded. When Epicenter quits or restarts, it asks the window first.
  The window stops taking input at once and waits for actions and saves
  already in progress. A failed save is not sent again. If nothing is left, it
  says so. Otherwise it offers **Keep working** or **Discard and quit** (or
  **Discard and restart**). Text not added yet, such as a new thought, is
  never added on its own because Epicenter is quitting. Neither choice
  changes your text: if another window keeps Epicenter open, everything is
  as it was.
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
relists the folder when the shell reports a change, every 30 seconds while
the window is visible, and when the window regains focus. An open capture
shows another program's edit only after Reload from file.

The Epicenter desktop shell owns that directory, through the shared folder
plugin in
[`packages/tauri-plugin-epicenter-folder`](../../packages/tauri-plugin-epicenter-folder/README.md).
Its README states what the owner promises and what it does not. What that
means for Capture:

- One Epicenter owns the directory at a time, through a lock file beside it,
  `.so.epicenter.capture.epicenter-lock`. A second one is refused with a
  message naming the directory.
- Other programs are not asked to take the lock. An open capture's save,
  including a repair in Source, replaces the whole file without reading it
  first, so another program's edit since the capture was opened or reloaded
  is overwritten. A save requires the file to be there when
  its bytes land, so a file another program removed is not put back. A copy
  creates a file that must not exist; an import and a delete name the version
  the window read, and the owner refuses them if the file is no longer that
  version, though an edit in the instant between the owner's last check and
  its change is still overwritten. None of these is an operating-system
  compare-and-swap.
- The owner watches the directory and also rechecks it on a timer, so a
  change the operating system did not report is still announced. A change
  announced to the window is a hint to relist. It never carries file contents
  and never replaces what an open capture shows.
- Complete saves request automatic local history from the owner, whether or
  not a Capture window is still open. While Git is busy, requests coalesce
  and wait for protection. A failed checkpoint stays visible and needs a
  newer save or an explicit commit. The window schedules no commits.
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
replaces the existing file whole on each save and never creates one, and
`delete`, which acts only on the version that was reviewed; the Git snapshot
and commit; and three file verbs for copies, restores, and imports under
`captures/*.md` and `recovery/*`: `read`, `create` (refused when anything is
at the path), and `replace` (refused unless the file is still the exact one
that was read). It takes no raw verb that overwrites. That surface is the
`CaptureFolder` type in `src/lib/platform/types.ts`. The plugin
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
| The page is destroyed or reloaded | `captures.close()` fences every input and waits for the page's create, import, copy, delete, and every accepted save before `host.close()` stops change hints and detaches this page's session. Teardown does not send a failed save again, and writes no unadded text. The folder stays open in the shell for its other windows. |
| The Capture window is closed | The shell hides it. The page, its session, and its drafts stay loaded. |
| The shell closes the folder | The folder's Git snapshot arrives with `closed`. The window says saving cannot be confirmed, keeps every draft, and holds reloads back. |
| Epicenter's Bun service stops (`host-stopped`, sent to this window) | A notice. The folder is the shell's, so saving carries on. The service served this page, so a reload may fail until Epicenter restarts. |
| A reply to a save is lost | The capture keeps its text and is marked not confirmed, with the exact report. The latest waiting edit proceeds, and later edits save again. Try again resubmits the current text. |

### Quitting and restarting

Epicenter asks its windows before it quits, or restarts for an account
change, over the departure wire that `@epicenter/epicenter/departure`
publishes (`apps/epicenter/src/departure-wire.ts`). That module states the
wire and its page rules; this page imports its names and its status parser,
and nothing else from the host package. The host runs one round for every
window it serves and decides; this page answers only for its own drafts.

| Host to page | Page to host |
| --- | --- |
| Event `departure-changed`, sent to this window: read the status again | `invoke('departure_status')`, which returns the status |
| | `invoke('departure_answer', { generation, round, answer })`: `asking`, then `ready` or `cancel` |
| Event `host-stopped`, sent to this window | None. The page shows the notice above. |

The page side is `src/lib/platform/departure.svelte.ts`:

- It registers its listener on this window, then reads the status. Until a
  status is `idle` the page shows no input; if registration or that read
  fails, it says so and offers Try again.
- A round it has not handled fences every input and action before anything
  is awaited, answers `asking`, then settles: every admitted save and action
  finishes, and a failed save is not sent again. With nothing
  left, it answers `ready`. Otherwise the person chooses Keep working
  (`cancel`) or Discard and quit, or restart (`ready`). Neither choice
  closes, discards, or changes what the page holds.
- A round that arrives while the folder opens waits for it; a page whose
  folder did not open answers `ready`, and its Try again stays disabled until
  the round ends.
- The same round with no vote means Quit was pressed again: a page still
  deciding sends `asking` again, and never asks the person a second time. A
  newer round is taken up while the page stays fenced.
- Once the page has answered `ready` or `cancel` for a round, any read of that
  round that does not show its answer (lost, or reset by Quit pressed again)
  sends the same answer again, with no new question and nothing changed.
- Only an `idle` status newer than the round gives the page back. `granted`,
  `leaving`, and a `discarded` vote keep it fenced and close the question. A
  lost or refused answer never gives it back; a nudge, Check again, or focus
  while fenced reads the status again. Older statuses are ignored.
- Settling waits for every action the page admitted (a create, an import, a
  copy, a delete, a restore and the reload after it) and for every admitted
  save. Closing the page waits for the same.

Which quit paths the host routes through a round, and what it does for a
window that stays silent, are the host's; see `apps/epicenter`.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the OPFS folder, `folder.epicenter-host.ts` attaches to the shell's directory and its departure wire, and `departure.svelte.ts` is the page's side of that wire. `auth.*.ts` is used only by the old-data export. |
| `src/lib/draft.svelte.ts` | One open capture: the row editor acquired once and kept for its file, read through its Svelte facade and never copied, and the form text it does not have yet: unadded thoughts, a thought being edited, and capture text that could not be applied. Every change is submitted at once. Choices for failed saves, reload, removal, deletion, and copies. |
| `src/lib/captures.svelte.ts` | The listing, the open drafts, the fence for leaving and closing, and completion of create, import, copy, delete, and draft saves. |
| `src/lib/recovery/` | Opens the old account store for an export. Loaded only from the recovery screen. |
| `src/lib/components/` | The timeline, a capture, its save and delete notices, and the recovery screen, composed from `@epicenter/ui`. Every binding reads the draft its view has at the call, and returns once its view is not the one shown or has been destroyed. |

The package exports nothing. No host imports a part of this app.

## Checks

```sh
bun run --cwd packages/folder build:addon   # once: the exchange a directory folder replaces files with
bun test packages/capture
bun run --cwd apps/capture test             # unit tests, then the mounted components
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # both seam leaves and the scripts
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:epicenter  # the build Epicenter serves
bun scripts/check-ui-boundary.ts
```

The two builds share SvelteKit's output directory, so run them one after the
other. The mounted tests run with `--conditions=browser --conditions=svelte`
(`test:mounted`), so Svelte and the UI kit resolve as a page build resolves
them.

| Test | What it checks |
| --- | --- |
| `src/lib/platform/folder.epicenter-host.test.ts` | The desktop leaf over the real folder adapter and row editor, with the shell's `invoke` and events scripted: refusals fail the open, departure is heard on this window only, closing detaches once and waits for admitted saves, and the collection keeps a capture's text through a lost or failed reply, a failed reload, and a removed file; the next save replaces a corrupt or outside-changed file, and a change hint never reads into an open capture. Try again sends exactly the latest accepted text, and an import interrupted by a lost reply is finished by a retry. It does not run the Rust owner. |
| `src/lib/platform/departure.test.ts` | The departure wire against a scripted host: registration before the first read, rounds that arrive while the folder opens, repeated and newer rounds, lost and reset answers sent again until idle, out-of-order statuses, discarded votes, and a real collection whose drafts come back unchanged after another page cancels. |
| `src/lib/platform-selection.test.ts` | Which leaf each build bundles: the desktop bundle has the desktop adapter, the departure client, and of the host package only its wire module, and no browser adapter, browser storage, Git implementation, or Node module; the browser bundle has the browser adapter and no desktop adapter, generated bindings, or departure gate. |
| `src/lib/captures.test.ts`, `src/lib/draft.test.ts` | The collection and the draft over a real directory and the folder's real row editor: complete-row saves submitted at once, latest save wins over an outside change, explicit reload, later input saving after a failed save, removal without resurrection, restores waited for through their reload, a file that came back written over by an explicit retry, exact text or no copy, repair in Source with no other writer, reviewed deletion without a second read and none while leaving, copies, leaving, and closing. |
| `src/lib/components/capture-detail.mounted.test.ts`, `timeline.mounted.test.ts` | The real capture view and timeline mounted in jsdom over real drafts and the real collection: a view kept mounted while its draft changes writes to the draft it has then; a text box whose view or block went away delivers nothing, even after the view makes a new one; a thought's editor writes only to that thought; a capture whose editor could not open says why and shows no text box; the deletion review outlives its view and deletes nothing while leaving; Source saves CRLF files exactly; and a fenced capture takes nothing. It shows what a delivered event does; jsdom has no layout, focus, selection, or IME. |

The Rust owner, its watcher, its lock, and its history are tested in
`packages/tauri-plugin-epicenter-folder` and in
`packages/folder/src/tauri-native.test.ts`. The desktop window itself is
checked by hand in the Epicenter shell.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit and tab keys, source editing, reload, Reload from file and latest save wins across pages, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | A standalone tool, not the desktop backend: imports a bundle into a real directory twice, through `@epicenter/folder/bun` with an explicit author and no remote, and prints both reports. Exits nonzero if the retry creates anything. Run `bun run --filter @epicenter/folder build:addon` first, or use `bun run harness:recovery` here, which does. |
