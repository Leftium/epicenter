# Edit handle experiment

Status: experimental evidence, wave 3. Nothing here is part of
`@epicenter/folder`, and production `Folder` code is unchanged.

Boundaries: one handle edits one file, its fields, body, and raw source
together. It is not a transaction across files. Saves and the demo's other
writer change only files in a disposable temp folder; the page reads its
caller sources from this checkout and never writes them.

## Question under test

Can one framework-neutral edit handle serve vanilla DOM, Solid, and Svelte 5
callers through their native subscription contracts, while keeping the
folder's publication facts honest when another writer races a save?

The page lets you judge that by using it: three callers share one handle, a
second handle competes on the same row, and manual gates stop a save at exact
publication moments while another program edits the file.

## Run it

From the repository root:

```sh
bun packages/folder/evidence/edit-handle/dev.ts
```

It prints a localhost URL (port `5179`, or `PORT`). The server creates a fresh
directory under the OS temp directory, seeds it, and opens it with
`@epicenter/folder/bun`. Reset replaces that directory; exit removes it. No
other files are read or written.

The demo toolchain (Solid, Vite, Svelte, svelte-check, and `@types/node`
24.12.2 to match the root's Bun types) is this directory's own
`node_modules`, pinned by its `package.json` and `bun.lock`. This directory is
not a workspace package and the root manifest and lockfile are untouched.
When `node_modules` is missing, `dev.ts` prints the install command:

```sh
bun install --cwd packages/folder/evidence/edit-handle --frozen-lockfile
```

## The API under test

A form that keeps a draft opens a handle and shares it with every control:

```ts
const edits = createFolderEdits(folder);           // a Folder, or the demo's HTTP facade
const edit = edits.tables.todos.edit(displayed);   // a fresh handle on the snapshot you show

edit.get();                         // immutable state, the same object until it changes
edit.subscribe((state) => {});      // called now, then on each change; returns unsubscribe
edit.change({ fields: { title } }); // prepare a new candidate, or refuse and keep it
edit.input(source);                 // replace the candidate source, parsed or not
await edit.save();                  // one conditional save against the displayed baseline
edit.discard();                     // the candidate becomes the baseline's text
edit.keepDraft(incoming.snapshot);  // keep the draft, now conditional on what was reviewed
edit.takeObserved(incoming.snapshot);
await edit.refresh();               // read the file now
await edit.dispose();               // stop observing; an admitted save still settles
```

Framework callers use only their native contracts: Solid's
`from(edit, edit.get())` and Svelte's `$edit` store subscription.

A one-click control keeps no draft and needs no handle:

```ts
const saved = await edits.tables.todos.save(displayed, { fields: { done } });
if (saved.error?.name === 'Conflict') showFileAsItIsNow();
```

`save` patches exactly `displayed.source`, keeping unknown keys, comments,
and every other byte, and calls `table.replace(displayed, prepared)` once. A
change the source cannot take returns `Unparsed`, `UnsupportedSource`, or
`InvalidValues` and writes nothing. A stale snapshot is a `Conflict`; a lost
reply is `Unconfirmed`. Nothing retries. It has no lifecycle; the caller owns
which paths have a save pending.

`edits.files.edit(textCapture)` is the same handle on a text file, without
`change`.

Each `edit()` call opens a new handle. Controls that should share a draft
share the handle object; there is no registry, reference count, or global
store, and no per-control focus protocol. Save timing belongs to the caller.

The state keeps `baseline` (the capture the next save targets), `source` and
its `reading`, `incoming` (a file observation the draft has not adopted),
`saving`, and `lastSave`. It has no `canSave`. `lastSave` is history: an
`unconfirmed` outcome stays unconfirmed, and the file afterward is observed
like any other change.

| Situation | What the handle does |
| --- | --- |
| Clean, the file changed | Adopts the file as baseline and draft. |
| Dirty, the file changed | Keeps the draft and baseline; shows the file as `incoming`. |
| The own save's text is read before its reply | Marks `saving.seenOnDisk`; not a change from elsewhere. |
| Typing during a save | Stays in the draft, unsaved against the receipt. |
| Another writer after the own publication | Reread after the reply: adopted when clean, `incoming` when dirty. |
| A read that started before a reply finishes after it | Dropped and repeated. |
| The file is removed, or its bytes are not UTF-8 | `incoming` is `missing` or `unreadable`; the baseline stays. |
| The reply is lost | `lastSave` is `unconfirmed` and stays so. Reading the submitted text later does not prove this request wrote it. The baseline stays until an ordinary observation moves it. |
| A late B arrives after an unconfirmed save | Clean (for example after Discard): adopted like any change, and nothing writes A back. Dirty with newer C: B is `incoming` for review; `keepDraft(B)` makes the next save of C conditional on B. |
| Conflict | Reported once. Nothing retries; the baseline stays the displayed one. |
| Resolution | Acts on the snapshot passed in. A newer file stays `incoming`. |
| A snapshot of another row or file | Opening a handle on it throws; `keepDraft` and `takeObserved` refuse it as `otherPath` and change nothing. |
| `change` on source that does not parse, or cannot take the change | Refused; the candidate is untouched. `input` and `save` still work. |
| Input with a lone surrogate | The draft holds U+FFFD, the text UTF-8 writes, so a saved draft is clean and the own text is recognized on disk. Nothing else is normalized. |
| `discard` while a save is admitted | Refused (`saving`): a discard cannot cancel that write. Once the save settles, even as `unconfirmed`, discard returns the draft to the baseline; a missing or unreadable file stays `incoming`. |
| A listener that disposes or saves again during delivery | The admitted save is recorded before anyone hears `saving` and released before anyone hears its outcome, so `dispose()` waits for the right write. |
| `dispose` | Unsubscribes and refuses new input, reads, and saves. An admitted save still lands in the state and settles the returned promise. |

## Compared with the Todos app's callers

| Concern | `apps/todos` | This experiment |
| --- | --- | --- |
| Who keeps an editor alive | The retained map in `todos.svelte.ts` owns each open editor's lifetime and its path reservations. | Whoever calls `edit()` owns the handle and disposes it; nothing retains it for them. |
| A toggle with no open editor | `table.update(stem, { fields: { done } })` reads the file as it is now and patches that, so it lands on whatever the row became after it was shown. | `edits.tables.todos.save(displayed, …)` patches the displayed version and is a `Conflict` if the row changed since it was shown. |
| A toggle while the row is open | Joins the editor: patches its buffer and saves through it. That join is app policy. | The immediate checkbox does not join the shared form. It saves on its own, and the form sees the file as changed elsewhere. Joining stays an app decision. |
| Overlapping toggles | A path reservation refuses an overlapping operation as busy. | The checkbox caller keeps a pending map per path, refuses a second change, and shows the wanted value disabled until the save answers. |

## Autosave is app policy

The page offers "Autosave shared draft (400 ms)", off by default. It lives in
`web/autosave.ts` and `web/main.tsx`, beside the shared handle and outside
every view, so it survives remounting all three. The engine has no autosave
method; the driver uses `get`, `subscribe`, and `save`:

```ts
const autosave = createAutosave(shared, {
  delayMs: 400,
  onPauseChange: (reason) => showAutosavePause(reason),
});
toggle.onchange = () => (toggle.checked ? autosave.start() : autosave.stop());
resume.onclick = () => autosave.resume();
```

- One timer and one subscription per retained draft. A dirty draft saves
  after 400 ms without new input, only while nothing is saving, nothing is
  incoming, and the handle is not disposed.
- Typing during a save starts no timer. If that save's receipt leaves newer
  text dirty, a fresh delay starts, and that save is conditional on the receipt.
- A new conflict, failure, or unconfirmed outcome pauses autosave. Typing,
  rereads, and remounts never clear the pause; only Resume does. Resume does
  not save over an incoming file: Keep or Take must review it first, and
  that save is still conditional. Nothing retries.
- `stop()` ends the timer and subscription and is separate from
  `shared.dispose()`. Stopping does not clear a pause.

The 400 ms delay is the page's choice, passed in because it is app policy;
the tests run the same driver with 20 ms and real timers.

The driver returns only `start`, `stop`, and `resume`. Its pause-change callback
updates the page's message. The edit handle remains the native readable store.

## Wave 3 changes

| Change | Why |
| --- | --- |
| Deleted the separate unconfirmed tracker (`state.unconfirmed`), the `observed` outcome, its text-matching branch, the `unconfirmed` discard refusal, resolution's retirement step, and the Stop waiting UI. | An unknown outcome is history. What the file holds later is an ordinary observation; a matching text cannot prove this request published it. Discard after an unknown save returns to the baseline, and a late B is then adopted cleanly. With newer C drafted, B is `incoming` for review instead of silently becoming the baseline. |
| Added app-owned autosave beside the shared handle. | Shows that save timing composes over the public handle without engine support. |

## Wave 2 repairs

| Failure seen in wave 1 | Repair |
| --- | --- |
| The immediate checkbox reverted to the old value while saving; any hint rebuilt it enabled; a second click published while the first was held. | One-shot `save` with a caller-owned pending map: the wanted value stays shown and disabled through every rerender, and a second change on the path is not admitted, even one dispatched by script. |
| A removed row came over the wire as `{ error: null }`; the facade threw on `undefined.source` and showed it as unreadable. | The server sends `data: null`; the facade decodes `null` as absent. `server.test.ts` covers it end to end. |
| "Saved: the file now holds B" while C was already incoming. | "This save wrote version B", and "was observed on disk" while held. |
| `keepDraft` or `takeObserved` with another path redirected the next write. | Refused as `otherPath`; construction binds the path. |
| A listener disposing at `saving` got `undefined`; a save started on B's receipt was cleared by B's continuation. | Admission is set before notification and released by identity before the outcome is delivered. |
| A lone surrogate saved as U+FFFD but the draft stayed dirty, and own-text checks failed. | `input` drafts the well-formed text. |
| Discard during a save made the old text dirty against the receipt. | Discard is refused while a save is admitted. (Wave 2 also refused it while unconfirmed; wave 3 removed that.) |
| A refused structured change left the rejected value in the control. | All three callers repaint that control from `edit.get()`. |

## Simulation limits

- The browser reaches the folder through `web/folder-http.ts`, a facade over
  HTTP and one EventSource. Real folder methods run on the server.
- "Lose next reply" runs the save and then reports `Unconfirmed`. The Bun
  folder never returns `Unconfirmed`; this stands in for a dropped connection
  or a desktop owner whose reply did not arrive.
- The other writer is `node:fs` on the same directory. The Bun folder does
  not watch other programs, so the server sends an explicit harness hint after
  each such write. The event log labels each hint's origin.
- Requests are not serialized, so a held save does not block the writer that
  races it. The folder's hash check is best effort against native writers, as
  its README says; nothing here claims more.
- The facade runs `inspect` in the page with the folder's internal
  `inspectSource`, because the public contract has no `inspect` without an
  opened folder.

## Browser journeys

1. Type a title in the Solid panel. Vanilla, Svelte, and the raw source follow.
   Save; the log shows "Published", and the disk keeps the `owner:` line and
   the comment.
2. Refused change, all three callers: in the raw source, change the title line
   to `title: !!str Plan the launch`. The source still parses, so the controls
   stay enabled. Type in the title field of each panel in turn: every keystroke
   is refused as unsafe, the refusal is shown, and that field returns to
   `Plan the launch`. A duplicate key does not show this: it fails parsing and
   disables the controls.
3. Arm "hold before publication", edit, Save, change the title as the other
   writer, Release: a conflict and a review; try "Keep my draft" then Save, and
   "Take this version".
4. Arm "hold reply after publication", Save: the status says the submitted text
   was observed on disk, nothing is incoming. Type more, Release: saved, still
   dirty, and "This save wrote version …". Discard while held is refused.
5. Arm "lose next reply", Save: "Unknown". The file read afterward holds the
   draft, so the draft is clean, and the last save still says "Unknown".
   Then arm both "hold before publication" and "lose next reply", Save,
   change the title as the other writer, Release: the save conflicted but its
   reply is lost, so it shows "Unknown" with the changed file incoming. Discard
   works and adopts that file.
6. Immediate checkboxes: arm "hold before publication" and click `plan`. It
   stays checked and disabled through hints from other saves; clicking again
   does nothing. Release: saved, or a conflict shown with the file as it is.
7. Remove the file: the status says it was removed, not unreadable. Write
   non-UTF-8 bytes: it says the file cannot be read. Reset reloads the page.
8. Unmount and remount the three views; the draft survives. Edit and save
   `notes.txt`.
9. Autosave across remounts: turn on autosave, arm "hold reply after
   publication", and change the title (B). When B is held, unmount the three
   views, mount them again, and type a new title (C) in any panel. Nothing
   publishes while B is held. Release: B's receipt arrives, then after 400 ms
   C publishes once, conditional on B.
10. Autosave pause: with autosave on, arm "hold before publication", type,
    change the title as the other writer when held, Release. Autosave says it
    is paused after a conflict. Typing and "Read file now" do not save.
    Resume alone still does not save over the incoming file; "Keep my draft
    over this version" then saves once.

## Files

| File | Role |
| --- | --- |
| `edit-handle.ts` | The engine: one handle over a supplied document. No Markdown or storage imports. |
| `folder-edits.ts` | `createFolderEdits`: binds table rows and text files, and the one-shot `save`. |
| `gates.ts` | Manual publication gates, shared by the server and the tests. |
| `server.ts`, `protocol.ts`, `todos.ts` | The Bun backend, its wire format, and the demo definition and seed. |
| `dev.ts`, `vite-config.ts`, `build.ts` | Launcher, Vite configuration, and a compile check. |
| `web/vanilla.ts`, `web/SolidPanel.tsx`, `web/SveltePanel.svelte` | The three callers of the shared handle. |
| `web/immediate.ts`, `web/notes.ts` | One-click saves without a handle; `files.edit` on `notes.txt`. |
| `web/autosave.ts` | The page's optional autosave policy for the shared draft. |
| `web/folder-http.ts` | `createHttpFolder` over any request sender, and the page's connection. |
| `web/handle-status.ts`, `web/harness.ts`, `web/main.tsx` | Status and review, harness and disk view, page composition. |

## Checks

The implementation waves, independent challenges, browser evidence, and
accepted tradeoffs are recorded in [ITERATIONS.md](./ITERATIONS.md).

From the repository root:

```sh
bun test packages/folder/evidence/edit-handle                # engine, real folder, server and facade
bun packages/folder/evidence/edit-handle/build.ts            # Vite build to dist/
bun run --cwd packages/folder/evidence/edit-handle check     # svelte-check: .ts, .tsx, .svelte
bun run --cwd packages/folder typecheck                      # also covers this directory's .ts files
```
