# Row editor callers

Status: evidence page for the production row editor. It opens a real,
persisted folder with the production browser opener and edits rows with
`folder.tables.todos.edit`, from vanilla DOM, Solid, and Svelte 5 callers.
The page is not part of `@epicenter/folder`; the wave 4 page in `web/` is
unrelated and unchanged.

## Question under test

Can one row editor, opened and disposed by its owner, serve three framework
views through their native subscription primitives over the folder a real
application gets? And do its baseline, observation, and save outcome stay
honest when the file is reformatted, changed in another tab, removed, or
cannot be opened as a form?

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
same files across reloads and tabs. Clearing site data for the origin removes
the folder.

`dist-canonical/` is build output. The root `.gitignore` does not cover it, so
delete it rather than staging it.

## What the page writes

- Loading lists the todos table. Only a folder with no todo rows is seeded,
  with one exclusive `files.create` per seed row, in order. A path that is
  already occupied, for example by a second tab seeding at the same moment,
  is logged as occupied and left as it is; nothing overwrites it. Any other
  failure stops seeding at that path, and the rows created before it stay.
  A folder that has rows is never written on load, so a removed seed row
  stays removed.
- Opening a row never writes. A hand-formatted file stays byte for byte until
  a person saves.
- Saves come only from the editor's `save()` and from explicit raw actions:
  the repair panel's overwrite and the raw file panel's writes, all through
  `folder.files`.
- "Reset the demo rows…" is a workflow for this disposable folder only. It
  asks first, then calls `files.overwrite` for each seed row and
  `files.remove` for `todos/gone.md` against the bytes it just read, one file
  at a time. Other tabs hear each write. The first failure stops the reset:
  the writes before it stay, and the events log names each completed write
  and the path where it stopped. Replaced text is not guaranteed to be kept.
  Automatic commits are best effort, so "Show recent commits" lists only the
  versions history recorded.

Nothing on the page simulates a fault. A held, lost, or throwing save reply,
and a slow read during opening, are unit-test conditions in
`src/editor.test.ts`, whose storage fake can hold reads and replies.

## Call sites

The owner (`canonical-web/main.tsx`) opens with a signal and checks the
Result before it uses the editor:

```ts
const { data: next, error } = await folder.tables.todos.edit(stem, {
	signal: controller.signal,
});
if (controller.signal.aborted) {
	if (error === null) void next.dispose(); // opened after it was superseded
	return;
}
if (error !== null) return mountRepair(slot('repair'), { error, path, files: folder.files, reopen });
```

Views destructure the methods they call; none reads `this`:

| Caller | Subscription | Unmount |
| --- | --- | --- |
| `vanilla.ts` | `const unsubscribe = subscribe(render)` | `unsubscribe()` |
| `SolidPanel.tsx` | `from({ subscribe }, get())` | Solid owner cleanup |
| `SveltePanel.svelte` | `createSubscriber((update) => subscribe(update))` read with `get()` in a `$derived` | Svelte stops the subscriber when no effect reads it |

Every control calls `change`. Removing a field passes `undefined`. A refused
change is repainted from `get()`. Each view's Save button calls `save()`.
The status panel (`status.ts`) calls `refresh` and `adopt`, and its
subscription probe shows that the first call is the current state and later
calls are changes. Unsubscribing the probe stops only the probe. Only the
owner calls `dispose`, on Close, Reset, or before opening another row.

## Browser journeys

The page lists these too.

1. Load. `todos/plan.md` is hand-formatted: a comment, single quotes, keys
   out of declared order, and the undeclared keys `owner` and `labels`. It
   opens with no unsaved changes and nothing is written. The status says the
   baseline is formatted differently, and "What Save writes" shows the
   canonical text with `owner` and `labels`.
2. Type `A` as the title in any view. All three show `A` and the issue "must
   not have fewer than 3 characters". Save says the draft has issues and
   writes nothing. Type on to `ABC`; the issue clears.
3. Save with no edits. The disk text becomes canonical, with the comment gone
   and `owner` and `labels` kept. The draft stays clean.
4. Reload. The row reopens from the folder with the saved text. An unsaved
   draft lived in the page and is gone.
5. Second tab. Open the same address in another tab. Save in one tab; the
   other tab's clean editor follows. Type in the other tab first, then save
   in this one: the other keeps its draft and shows "Take this version" and
   "Keep mine: save".
6. Raw file panel, one tab. "Same values, reformatted" while clean: the
   editor follows, stays clean, and the baseline is formatted differently.
   With unsaved changes, "Change the title" shows the review.
7. Unmount the three views, change the file, mount them again: they show the
   same draft and the latest observation.
8. "Remove file": the latest read is "no file"; draft and baseline stay.
   "Save my draft" writes it back.
9. Choose `tagged`. Opening refuses, writes nothing, and the repair panel
   shows the exact text. Remove `!person`, then press "Overwrite the file with
   this text"; the row opens. `urgent` repairs the same way. `gone` starts
   from a new row. "Write invalid UTF-8" makes opening refuse with no text.
10. "Reset the demo rows…" asks, then puts the seed rows back; the other tab
    hears it.

## Wave 6 history

Everything below was recorded in wave 6, before production integration. The
callers then ran against the experimental wrapper
`createCanonicalEditors(folder, definition)` over an in-memory harness
folder (`canonical-web/memory-folder.ts`) with hold-reply, lose-reply, and
slow-read gates. Wave 7 deleted the wrapper, its codec and tests, and the
harness; the findings and their regression tests now live in `src/` (see
[ITERATIONS.md](./ITERATIONS.md)). The gated journeys below (held and lost
replies, cancelling a slow open, close during a held save) are not
reproducible on the current page.

### Review findings and repairs

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

### Ownership and ergonomics

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

### Observed browser evidence (wave 6, in-memory harness)

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

## Files

| File | Role |
| --- | --- |
| `canonical-dev.ts` | Vite dev server on port 5181 and the shared Vite config |
| `canonical-build.ts` | Builds the page to `dist-canonical/` as a compile check |
| `canonical-web/todos.ts` | Demo definition (title with `minLength: 3`), folder ID, and seed rows |
| `canonical-web/main.tsx` | Owner: open the folder, seed an empty one, open rows with abort, repair on refusal, mount views, dispose, reset |
| `canonical-web/vanilla.ts`, `SolidPanel.tsx`, `SveltePanel.svelte` | The three callers |
| `canonical-web/status.ts` | Baseline, latest read, canonical output, outcomes, review, probe |
| `canonical-web/raw-files.ts` | Real raw reads and writes through `folder.files`, as another caller in the same tab |
| `canonical-web/repair.ts` | Raw repair when opening refuses |
| `canonical-web/todo-editor.ts`, `dom.ts` | Shared types, draft values, messages, DOM helper |

## Checks

```sh
bun packages/folder/evidence/edit-handle/canonical-build.ts
bun run --cwd packages/folder/evidence/edit-handle check
bun run --cwd packages/folder typecheck
bun test --isolate packages/folder/src/editor.test.ts packages/folder/src/canonical.test.ts
```

Browser acceptance of the current page is recorded by the integrating
reviewer; this document records none for it yet.
