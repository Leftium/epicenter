# Capture

Capture keeps dated captures, newest first. Each capture is one Markdown file:
its text, then its thoughts as a bullet list under `## Thoughts`. The files
are the saved data, and Git records their history. There is no account and no
sign-in on this path. The file format and its rules are in
[`packages/capture`](../../packages/capture/README.md).

There are two builds of the same UI, and the build decides where the folder is:

| Build | Folder | History |
| --- | --- | --- |
| Desktop, inside Epicenter | An ordinary directory, opened by the Epicenter host. | Real Git in that directory's `.git`. No remote. |
| Browser | A logical folder in this browser's IndexedDB. | Git objects in IndexedDB. No remote. |

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

- A save writes exactly the text it captured, and only if the file is still
  the one this window read. Typing during a save stays unsaved and saves next.
- Opening, selecting, and listing captures write nothing.
- **If the file changes outside this window** and you have nothing unsaved,
  the window shows the new file. If you do have unsaved text, your text stays,
  saving pauses, and the saved file is shown beside these choices:

  | The saved file | Choices |
  | --- | --- |
  | Changed | Load saved (discard my draft). Save my draft over this version. Save my draft as a copy. Download my draft. |
  | Removed | Save my draft back to this file. Save as a copy. Download. Discard my draft. |
  | Cannot be read | Check again. Save as a copy. Download. It cannot be overwritten, because it cannot be reviewed. |

  "Save my draft over this version" is checked against the version you were
  shown, so a further change asks again.
- **If a save cannot be confirmed**, the notice puts the choices first and
  keeps the exact failure under "Show technical details". Your text stays: Try again, Save as a
  copy, Download, or Discard my changes. The window does not claim the file is
  unchanged, because a write can reach the disk and its answer still be lost.
  Try again is checked against the file as the window last read it, so a
  write that did land shows up as a change to review.
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
  stay loaded. Using the Quit menu or Cmd-Q asks the window first. If everything saves,
  it quits. Otherwise it offers **Keep working** or **Discard and quit**.
- If the Epicenter host process stops, the window says saving cannot be
  confirmed. Your text stays so you can copy or download it, and reloads are
  held back.

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
The timeline shows the real path. Edit the files with any program: Capture
rereads when the operating system reports a change, a timer compares each
file's size and modification time to recover a missed report, and the window
rereads when it regains focus.

What is and is not protected:

- One Epicenter owns the directory at a time, through a lock file beside it,
  `.so.epicenter.capture.epicenter-lock`. A second one is refused with a
  message naming the directory.
- Other programs are not asked to take the lock. A save checks the file's
  version and checks again immediately before replacing it. An edit landing
  in the instant between that check and the replacement is overwritten. This
  is a best-effort check, not an operating-system compare-and-swap.
- A change that is neither reported nor visible in size or modification time
  is not noticed until the next reread. After each of its own writes the host
  compares the directory at once, so a file Capture created and another
  program then removed is noticed even when no report arrives.
- Capture refuses to open a directory whose `.git` is a symbolic link or a
  `gitdir:` file (a linked worktree or submodule), before running any Git
  command there. It checks when it opens the directory, not afterwards.

### How it is wired

```text
Capture window (WebView)
   POST /_epicenter/capture/call      one folder method
   GET  /_epicenter/capture/events    Git snapshots and "something changed" hints
        |  the host's browser session; calls also need the exact Origin
        v
Epicenter Bun host  ->  apps/capture/native  ->  openNativeFolder(<dir>)
```

`apps/capture/native` is the only owner of the directory in the host process.
It runs each call to completion before the next and accepts only the calls in
`CAPTURE_CALLS`. The folder itself commits after every complete save, table
or raw, in both builds; the owner adds no commit logic of its own. Raw reads and writes are
limited to `captures/<name>.md` and `recovery/<name>.json|md`, and a write
must name the version it replaces or require the file to be absent. There is
no terminal and no remote.

The build Epicenter serves is selected by the `epicenter-host` condition on
`#platform/folder`. That leaf opens no browser folder, so it cannot fall back
to IndexedDB: if the bridge does not answer, opening fails with the reason.

### Host integration

`apps/epicenter/src/main.ts` creates the bridge at
`join(boot.folderDir, captureDefinition.id)` and passes it to the host server.
Both shutdown paths drain and close it. The route comes from the exported
Capture bridge contract; the server requires its browser session and checks
Origin on calls that change data.

The Rust shell owns the quit handshake in `capture_lifetime.rs`. It accepts
answers only from the Capture window for the current request. If the page
does not acknowledge the request, a native dialog requires an explicit choice
before discarding its text. Closing the window hides it and retains the page.
Forced termination, OS termination requests such as Dock Quit, and the shell's
process restart bypass this handshake.

The page side of quitting is in `src/lib/platform/shell-lifetime.ts`:

| Shell to page | Page to shell |
| --- | --- |
| Event `capture-quit-requested`, payload: a numeric request ID | `invoke('capture_quit_answer', { requestId, answer: 'asking' })` at once, then exactly one of `'proceed'` or `'cancel'` |
| Event `capture-host-stopped` | None. The page keeps its text and holds reloads back. |

A request that arrives before the page is listening is acknowledged and
answered once it is. If the window cannot listen for these events, the page
says so in a notice instead of quitting unprotected in silence.

## Layout

| Path | Role |
| --- | --- |
| `src/lib/platform/` | The `#platform/folder` seam: `types.ts` is its contract, `folder.browser.ts` opens the IndexedDB folder, `folder.epicenter-host.ts` reaches the host's directory, and `shell-lifetime.ts` is the quit protocol. `auth.*.ts` is used only by the old-data export. |
| `src/lib/bridge/` | The desktop page's side of the bridge: the route and call list (`contract.ts`), the value encoding (`codec.ts`), and the transport and remote folder (`client.ts`). |
| `native/` | The host's side, Bun only: the folder owner and its queue (`owner.ts`), the directory lock, the change watcher, and the HTTP handler (`bridge.ts`). Exported as `@epicenter/capture-app/native`. |
| `src/lib/draft.svelte.ts` | One capture's draft: buffer, baseline, save queue, conflict choices, and unsent input. |
| `src/lib/captures.svelte.ts` | The listing, the open drafts, and every write. |
| `src/lib/recovery/` | Opens the old account store for an export. Loaded only from the recovery screen. |
| `src/lib/components/` | The timeline, a capture, the conflict choices, and the recovery screen, composed from `@epicenter/ui`. |

## Checks

```sh
bun test packages/capture apps/capture
bun run --cwd packages/capture typecheck
bun run --cwd apps/capture typecheck        # both seam leaves and the Bun side
bun run --cwd apps/capture build            # browser
bun run --cwd apps/capture build:epicenter  # the build Epicenter serves
```

The two builds share SvelteKit's output directory, so run them one after the
other.

| Script | What it checks |
| --- | --- |
| `bun run --cwd apps/capture smoke:browser` | The browser build in Chromium, with two pages sharing one folder: exact saved Markdown, thought edits, keyboard submit and tab keys, source editing, reload, outside changes, leave warnings, deletion, and an import. Needs a free local port and `bun x playwright install chromium`. |
| `bun apps/capture/scripts/recovery-harness.ts [dir] [bundle.json]` | Imports a bundle into a real directory twice and prints both reports. Exits nonzero if the retry creates anything. |
| `bun apps/capture/scripts/native-harness.ts <dir> [port]` | Serves the bridge and the desktop build on a loopback port, over a real directory, for checking the page and bridge independently of the Epicenter shell. |
