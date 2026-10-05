# Row editor callers

Status: evidence page for the production row editor. It opens a real,
persisted folder with the production browser opener and edits rows with
`folder.tables.todos.edit`, from vanilla DOM, Solid, and Svelte 5 callers.
The page is not part of `@epicenter/folder`; the wave 4 page in `web/` is a
separate, historical experiment.

The contract is "Editing a row" and "Editing a row in Svelte" in the package
README, and [ADR 0504](../../../../docs/adr/0504-row-editors-own-complete-input-and-one-publication-queue.md)
records the decision. This page shows callers of that contract; it adds no
API of its own.

## Question under test

Can one row editor, kept by its owner, serve three framework views through
their native primitives over the folder a real application gets, with each
input saved as the complete row? And do the views stay honest when the row
becomes invalid, when the file is changed, removed, or made again by another
caller, and when the owner leaves a row whose last save failed?

## Run it

From the repository root:

```sh
bun packages/folder/evidence/edit-handle/canonical-dev.ts     # Vite on localhost:5181, or PORT
bun packages/folder/evidence/edit-handle/canonical-build.ts   # compile check to dist-canonical/
bun run --cwd packages/folder/evidence/edit-handle check      # svelte-check, Solid and Svelte callers included
```

The page calls `openFolder` from `@epicenter/folder/browser` (imported as
`openBrowserFolder` from `src/browser.ts`) with the fixed, disposable ID
`so.epicenter.evidence.canonical-editor`. The opener chooses this browser's
default storage; the page shows `folder.location` as the opener reports it,
and prints any location kind it does not know as JSON. Today that is an
OPFS directory. When the default backend changes, the page follows it
without changes of its own.

Storage belongs to the page's origin. Keep the same host and port to see the
same files across reloads and tabs: `localhost` and `127.0.0.1` are different
origins. Clearing site data for the origin removes the folder.

`dist-canonical/` is build output. The root `.gitignore` does not cover it, so
delete it rather than staging it.

The Svelte view imports the package's adapter from `src/svelte`. The Svelte
Vite plugin dedupes `svelte`, so the adapter and the panel share this
directory's Svelte runtime; a second copy would track nothing.

## What the page writes

- Loading lists the todos table. Only a folder with no todo rows is seeded,
  with one exclusive `files.create` per seed row, in order. A path that is
  already occupied, for example by a second tab seeding at the same moment,
  is logged as occupied and left as it is; nothing overwrites it. Any other
  failure stops seeding at that path, and the rows created before it stay.
  A folder that has rows is never written on load, so a removed seed row
  stays removed. `crlf.md` joined the seed rows later: a folder seeded before
  it gets it from Reset.
- Acquiring an editor never writes. A hand-formatted file stays byte for byte
  until a person edits it.
- The editor writes each accepted input. Every write replaces the existing
  row; none creates it.
- The "Another caller" panel writes through `folder.files`, each write
  conditional on the bytes it just read. Only "Write the seed text" creates
  a missing file, as an explicit command.
- "Reset the demo rows…" is a workflow for this disposable folder only. It
  asks first, releases the open editor as Close does, then calls
  `files.overwrite` for each seed row and `files.remove` for `todos/gone.md`
  against the bytes it just read, one file at a time. Other tabs hear each
  write. The first failure stops the reset: the writes before it stay, and
  the events log names each completed write and the path where it stopped.
  Replaced text is not guaranteed to be kept. Automatic commits are best
  effort, so "Show recent commits" lists only the versions history recorded.

Nothing on the page simulates a fault. A held, lost, or throwing write, a
slow read during acquisition, and a removal that lands between an input and
its write are unit-test conditions in `src/editor.test.ts`. The OPFS
acceptance page (`../opfs/`) checks the removal against real browser storage.

## Call sites

The owner (`canonical-web/main.tsx`) acquires as the last step of a
transition, with a signal another request can abort, and checks the Result
before it keeps the editor:

```ts
const controller = new AbortController();
step.acquiring = controller; // a request during this transition aborts it
const { data: editor, error } = await folder.tables.todos.edit(stem, {
	signal: controller.signal,
});
step.acquiring = undefined;
if (error !== null) return showDiagnostic(error); // Aborted, NotFound, InvalidUtf8, InvalidPath, Io; no editor
owner = { stem, editor, views: { vanilla: { raw: false }, solid: { raw: false }, svelte: { raw: false } } };
showViews(owner);
```

Text that does not conform, or has no canonical form, still opens: the row is
`invalid`, and the same editor repairs it through its source view. A missing
file opens nothing, and nothing on the page creates it on acquisition.

Views destructure the methods they call; none reads `this`:

| Caller | Subscription | Unmount |
| --- | --- | --- |
| `vanilla.ts` | `const stop = subscribe(render); render()`: no initial call, so it renders `get()` itself | `stop()` |
| `SolidPanel.tsx` | `from((publish) => subscribe(() => publish(() => get())), get())` | Solid owner cleanup |
| `SveltePanel.svelte` | `fromRowEditor(rowEditor)` from `@epicenter/folder/svelte`; `editor.row` and `editor.save` read in the template | Svelte ends the subscription with the component |
| `status.ts` | `subscribe(render); render()` | `stop()` |

Solid's `from` has a `{ subscribe }` form, but it publishes the value its
listener is called with, and the editor's `invalidate` is called with none.
The setter form publishes `get()` at creation and after each invalidation.

Every structured handler reads the latest row with `get()` (the Svelte
setters read `editor.row`) and calls `set` with the complete row: every field
to keep and the body. Removing the priority omits its key. A view's handler
returns unless the row still supports that view: structured controls only
while the row is valid and shown as fields, the source only while it is
shown. A refused `set` accepts nothing; vanilla and
Solid put the control back from `get()`, and a Svelte binding shows the
accepted value again. Textareas show LF; setters restore the file's line
endings with `withFileNewlines`, for the body and for the source. A
structured save writes the header in LF and keeps the body's endings. The
source setter writes CRLF on every line when the text has any CRLF, header
included, so the header's endings follow whichever kind of edit came last.
Mixed endings come back uniform from any textarea edit.

Every input handler, in vanilla, Solid, Svelte, and the status panel, also
returns once its view has unmounted: the controls are detached then, but a
retained element can still receive an event from script or assistive
technology. Svelte's `unmount` removes the view at once even with no
transition, yet the listeners its bindings add to an element are never
removed (`listen_to_event_and_reset_event` in the installed Svelte), so the
Svelte setters check an `onDestroy` flag. A detached status retry or reload
would otherwise change input the owner is discarding, and a detached probe
would subscribe again.

Each view keeps its own choice of fields or source in its own object, which
the owner holds per editor. A view mounted again starts where it left off,
and no view reads another's choice.

The status panel shows the row, the save state, and the exact accepted text.
"Read the file again" calls `reload`: the file's text replaces the input and
clears a failed save, unless the read fails or the input changed while it
read, and the events log says which. After a failed save it offers "Save
this text again", which calls `retry`: a new attempt with the latest input.
Typing after the failure saves at once; nothing retries on its own. Its
subscription probe shows that `subscribe` makes no initial call.

### Leaving a row

The page keeps the editor; nothing disposes it. Close, Open, choosing another
row, and Reset are transitions. One runs at a time, from leaving the current
row to its last step, such as Reset's writes and the acquisition after them.
A request during one is refused and logged and leaves it running. Close is
the exception while a transition waits for `table.edit`: it cancels that
acquisition, which leaves no editor. The row a transition opens is the one
selected when the person asked, but the selector and the "Another caller"
panel move to it only after the release succeeds: while a failed save waits
for "Keep editing" or "Discard", the panel still targets the row whose input
failed, and it names its target path. Only `open`, as a transition's last
step after the release left no editor, installs an editor.

Leaving first unmounts every view, so no control can submit input. Then the
owner awaits `flush()`. If the last save failed, the page asks: "Keep
editing" mounts the views again over the same editor and ends the
transition, and the other choice drops the editor and its input. Opening the
row again reads the file; nothing adopts or overwrites anything on the way.

"Unmount the views" ends every view's subscription. The editor stays, and an
admitted write still settles; mounting again renders `get()`. Nothing reads
the file until "Read the file again".

## Browser journeys

The page lists these too.

1. Load. `todos/plan.md` is hand-formatted: a comment, single quotes, keys
   out of declared order, and the undeclared keys `owner` and `labels`. It
   opens valid, and nothing is written. The status panel shows its exact text.
2. Edit the title in any view. The other views follow, and each input is
   saved: the status panel shows the canonical text, with the comment gone
   and `owner` and `labels` kept.
3. Select the whole title and type `A`. A one-letter title is representable,
   so it is accepted and saved as typed. The row is now invalid
   (`Nonconforming`), and every view shows its Markdown source with the issue.
   Fix the title there; the row is valid again, and that view keeps the source
   until "Edit fields".
4. Choose "(none: remove the field)" for the priority. The key is omitted, so
   the saved row has no priority and is invalid until it is repaired.
5. `crlf.md`: edit the body, then the source. A body edit keeps the body's
   CRLF and writes the header in LF; a source edit then writes CRLF on every
   line, header included.
6. Choose `tagged` (`NoCanonicalForm`) or `urgent` (`Nonconforming`). Each
   opens invalid; repair it in the source view of the same editor.
7. Choose `gone`. Acquisition returns `NotFound` and no editor. "Write the
   seed text" under "Another caller" creates the file on purpose; then "Try
   opening again".
8. With a row open, "Remove the file" under "Another caller". The views keep
   the row. Type: the save fails with `NotFound`, the file stays absent, and
   further typing is kept but not written. "Read the file again" reports the
   file gone and keeps the input. "Write the seed text" makes it again;
   "Read the file again" then shows the new file and clears the failure.
9. Unmount the views, change the file as another caller, mount them again:
   the views render the editor's snapshot, unchanged until "Read the file
   again".
10. Open the same address in a second tab. Typing in one tab reaches the
    other when it reads the file again; concurrent typing in both is
    last-publication-wins.
11. "Write bytes that are not UTF-8": the views keep the row, "Read the file
    again" reports `InvalidUtf8`, and acquiring it again returns no editor.
12. "Reset the demo rows…" asks, releases the editor, then puts the seed rows
    back; the other tab sees them when it reads again.

`src/editor.test.ts` and the OPFS acceptance page also cover a write that
fails, its retained input, and a file made again afterward.

## Files

| File | Role |
| --- | --- |
| `canonical-dev.ts` | Vite dev server on port 5181 and the shared Vite config |
| `canonical-build.ts` | Builds the page to `dist-canonical/` as a compile check |
| `canonical-web/todos.ts` | Demo definition (title with `minLength: 3`), folder ID, and seed rows |
| `canonical-web/main.tsx` | Owner: open the folder, seed an empty one, acquire with abort, show acquisition failures, mount views, leave a row, reset |
| `canonical-web/vanilla.ts`, `SolidPanel.tsx`, `SveltePanel.svelte` | The three callers |
| `canonical-web/status.ts` | Row, save state, exact accepted text, reload, retry, subscription probe |
| `canonical-web/raw-files.ts` | Another caller in the same tab: conditional reads and writes through `folder.files` |
| `canonical-web/todo-editor.ts`, `dom.ts` | Shared types, complete-row builders, newline helpers, messages, DOM helper |
| `canonical-page.journeys.ts`, `canonical-page.test.ts` | The built page in jsdom over the in-memory OPFS: detached view and status controls do nothing, each view keeps its own mode across a remount, a held Reset refuses a competing Open, the raw panel stays on a failed row until its input is discarded, and only Close cancels a held acquisition |

## Checks

```sh
bun packages/folder/evidence/edit-handle/canonical-build.ts
bun run --cwd packages/folder/evidence/edit-handle check
bun run --cwd packages/folder typecheck
bun test --isolate packages/folder/src/editor.test.ts packages/folder/src/canonical.test.ts
bun test --isolate packages/folder/evidence/edit-handle/canonical-page.test.ts
```

`canonical-page.test.ts` runs `canonical-page.journeys.ts` in its own
process, because under `bun test --isolate` an `import()` of the page's
entry, which uses top-level await, returns at its first await and the rest
never runs. The journeys build the page with this directory's Vite
configuration, run its entry in jsdom over the in-memory OPFS, and act only
through its DOM. They show what a delivered event does; jsdom has no layout,
focus, IME, or assistive technology, and the memory OPFS is not a browser.

Browser acceptance of the current page is recorded by the integrating
reviewer; this document records none for it yet.

## History: the retired editor

Everything below describes the editor this page used before ADR 0504: a
draft with a baseline, `change`, an explicit `save` that refused
schema-invalid drafts, `adopt`, and `dispose`. That editor no longer exists,
and its names are not compatibility APIs.

### Wave 7

Wave 7 moved the editor into `src/` and ran these callers over a real
persisted folder with a Save button, a refusal of invalid drafts, a review
of incoming changes ("Take this version", "Keep mine: save"), and a repair
panel that overwrote files the editor refused to open. Its browser
acceptance is recorded in `../opfs/ACCEPTANCE.md` as history.

### Wave 6

Everything in this section was recorded in wave 6, before production
integration. The callers then ran against the experimental wrapper
`createCanonicalEditors(folder, definition)` over an in-memory harness
folder (`canonical-web/memory-folder.ts`) with hold-reply, lose-reply, and
slow-read gates. Wave 7 deleted the wrapper, its codec and tests, and the
harness (see [ITERATIONS.md](./ITERATIONS.md)). The gated journeys below
(held and lost replies, cancelling a slow open, close during a held save) are
not reproducible on the current page.

#### Review findings and repairs

The delegated consumer implementation exposed two engine bugs. Both were
reproduced before repair and now have regression tests:

- The first subscriber call could recurse, then finish by rendering an older
  state. Initial and subsequent notifications now use the same guarded loop.
  Subscriptions are independent, including two calls with the same function.
  Reentrant changes may coalesce intermediate states, and the last delivered
  state is current. This is a state subscription, not a complete event log.
- Disposal from a `saving` callback could resolve before the save reply. Save
  admission now precedes notification. Settlement releases only that admission
  before notifying listeners, so another save started from the outcome keeps
  its own admission. Disposal releases listeners after the final outcome drains.

The subsequent review improved three boundaries:

- `adopt` compares reviewed canonical content at the fixed path, then uses the
  latest internal revision. A formatting-only rewrite is accepted. Genuinely
  different content is refused. Supplied source, fields, and hashes cannot enter
  the editor through this operation.
- `change` autocompletes declared field names and rejects `titel`. Values stay
  broad enough to hold invalid intermediate input. Unknown metadata survives
  every ordinary save; editing it is a raw operation. The three callers infer
  the change parameter directly from their editor method.
- A submitted save has no hash. Only a confirmed storage receipt supplies one.
  This deletes a duplicate hashing step without weakening content comparison.
  An unexpected throwing write releases admission and propagates the bug; it
  is not silently converted into an unknown transport outcome.

#### Ownership and ergonomics

One form owns the editor. Each view owns its subscription. File watching starts
before opening's first read and continues with zero view subscriptions until
`dispose`. Tying the watcher to mounted views would leave retained drafts with
stale observations when the views are temporarily unmounted.

The local `document.fields` contains invalid intermediate values, so controls
cannot use the validated `reading.fields` projection. `draftOf` narrows values
for these specific DOM controls and is shared by all three callers. A typed
field name does not prove its in-progress value conforms to the schema.

Solid uses its native `from` primitive. Svelte uses `createSubscriber` with
`$derived`; there are no Svelte stores or binding DSLs. The editor and all its
methods can be destructured. A shared framework adapter would need repeated
production callers to earn its boundary.

`save()` always replaces the complete file, even when the local document is
clean. That lets explicit Save canonicalize hand-formatted source. An autosave
or quit policy that wants only unsaved work checks `isDirty` and decides how to
handle an external observation. Notifications cannot make saving conditional:
a write that lands after the latest read can still be overwritten.

The prototype repeated the definition in `createCanonicalEditors(folder,
definition)`. Production `folder.tables.todos.edit(stem)` captures schema and
declared order inside the table instead, and the current callers use it.

#### Observed browser evidence (wave 6, in-memory harness)

Computer use exercised the final engine in Chrome on 2026-10-04:

- A clean Save canonicalized the file and kept `owner` and `labels`.
- A clean editor followed an external formatting-only rewrite.
- Subscription delivered current state immediately; unsubscribing the probe
  stopped its calls while the editor kept running.
- Typing `A` remained visible in all three frameworks. Save refused it without
  changing the file. Further typing cleared the validation error.
- Submitted B landed while its reply was held. Newer C was typed in Svelte,
  views unmounted and remounted, then the receipt for B arrived. All three
  showed C, still dirty against B. [Screenshot](./canonical-journey.png).
- An external edit preserved dirty C. "Keep mine: save" wrote C canonically
  over the observed file.
- A lost reply left the save outcome unknown while the matching reread made
  content clean. The UI did not claim the reread confirmed that request.
- Deletion kept the draft. Recreation appeared as an observation, and taking
  that version replaced the local draft without writing.
- The custom-tag row refused structured opening. Removing the tag in raw
  repair and writing the replacement reopened all three form views.
- Cancellation within the delayed first-read window left the page cancelled.
- Close during a held save displayed waiting. Releasing the reply completed
  disposal and displayed Closed.

The `urgent` and `gone` menu journeys remain additional manual exercises;
invalid and missing opening cases have engine coverage. Browser evidence uses
an in-memory notification harness. It does not establish native watcher delivery
or browser cross-tab persistence.
