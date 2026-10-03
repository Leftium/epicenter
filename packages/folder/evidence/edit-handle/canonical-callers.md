# Canonical editor callers

Status: experimental evidence. It exercises `canonical-editor.ts` from real
vanilla DOM, Solid, and Svelte 5 callers. Nothing here is part of
`@epicenter/folder`; the wave 4 page in `web/` and the engine are unchanged.

## Question under test

Can one canonical editor, opened and disposed by its owner, serve three
framework views through their native subscription primitives? And do its
baseline, observation, and save outcome stay honest when the file is
reformatted, changed, removed, or answered late by its folder?

## Run it

From the repository root:

```sh
bun packages/folder/evidence/edit-handle/canonical-dev.ts     # Vite on localhost:5181, or PORT
bun packages/folder/evidence/edit-handle/canonical-build.ts   # compile check to dist-canonical/
```

The page has no server folder. It runs the editor over
`canonical-web/memory-folder.ts`, an in-memory test harness in the tab. That
harness is not a persistent backend: files vanish on reload or Reset. Its
`inspect` is the folder's own `inspectSource` over the demo definition, so
readings and issues come from the real conformance check. Its `read` and
`overwrite` return the folder's capture shapes and error variants, and every
write that lands announces a hint, the editor's own saves included.

`dist-canonical/` is build output. The root `.gitignore` does not cover it, so
delete it rather than staging it.

## Call sites

The owner (`canonical-web/main.tsx`) opens with a signal and checks the
Result before it uses the editor:

```ts
// Prototype wrapper; proposed production entry is folder.tables.todos.edit.
const { edit: openTodo } = createCanonicalEditors(folder, definition).tables.todos;
const { data, error } = await openTodo(stem, { signal: controller.signal });
if (controller.signal.aborted) {
	if (error === null) void data.dispose(); // opened after the cancel
	return;
}
if (error !== null) return mountRepair(slot('repair'), { error, path, files, reopen });
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

1. Load. `todos/plan.md` is hand-formatted: a comment, single quotes, keys
   out of declared order, and the undeclared keys `owner` and `labels`. It
   opens with no unsaved changes. The status says the baseline is formatted
   differently, and "What Save writes" shows the canonical text with `owner`
   and `labels`.
2. Type `A` as the title in any view. All three show `A` and the issue "must
   not have fewer than 3 characters". Save says the draft has issues and
   writes nothing. Type on to `ABC`; the issue clears.
3. Save with no edits. The disk text becomes canonical, with the comment gone
   and `owner` and `labels` kept. The draft stays clean.
4. Arm "Hold the next save reply" and press Save. The bytes land, and the
   latest read is described as the text the running save submitted. Type
   more in another view, then press Release. The save reports saved, the newer
   typing stays unsaved against the receipt, and the receipt is listed.
5. Arm "Lose the next save reply" and press Save. The result is Unknown. The
   reread finds the submitted text, so the draft is clean, and Last save
   still says Unknown.
6. Another program: "Same values, reformatted" while clean. The editor follows
   it, stays clean, and the baseline is formatted differently again. With
   unsaved changes, "Change the title" shows the review: "Take this version"
   adopts the displayed content from the latest equivalent revision; "Keep mine: save" overwrites it.
7. "Delete file": the latest read is "no file"; draft and baseline stay.
   "Save my draft" writes it back, or "Recreate from seed" restores it.
8. Type a change, then unmount the three views. The status panel keeps
   updating, for example after a change elsewhere. Mount the views again:
   they show the same draft and the latest observation.
9. Choose `tagged`. Opening refuses, and the repair panel shows the exact text.
   Remove `!person`, then press "Overwrite the file with this text"; the row
   opens. `urgent` repairs the same way. `gone` starts from a new row.
10. Check "Slow reads", press Open, then "Cancel opening": opening is
    cancelled, and nothing stays subscribed.
11. Hold a save reply, then press Close. The page waits for the admitted save;
    Release finishes disposal. Reset releases any held reply first, reseeds,
    and reopens.

## Review findings and repairs

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

## Ownership and ergonomics

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

The prototype repeats the definition in `createCanonicalEditors(folder,
definition)`. The proposed production `folder.tables.todos.edit(stem)` should
capture schema and declared order inside the table instead. This experiment
establishes callers and lifecycle; it does not add a production export.

## Observed browser evidence

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
| `canonical-web/todos.ts` | Demo definition (title with `minLength: 3`) and seed files |
| `canonical-web/memory-folder.ts` | In-memory harness folder, gates, and other writer |
| `canonical-web/main.tsx` | Owner: open with abort, repair on refusal, mount views, dispose |
| `canonical-web/vanilla.ts`, `SolidPanel.tsx`, `SveltePanel.svelte` | The three callers |
| `canonical-web/status.ts` | Baseline, latest read, canonical output, outcomes, review, probe |
| `canonical-web/harness.ts`, `repair.ts` | Harness controls; raw repair when opening refuses |
| `canonical-web/todo-editor.ts`, `dom.ts` | Shared types, draft values, messages, DOM helper |

## Checks

```sh
bun packages/folder/evidence/edit-handle/canonical-build.ts
bun run --cwd packages/folder/evidence/edit-handle check
bun run --cwd packages/folder typecheck
```

The full experiment suite passes: 83 tests and 376 assertions. The Svelte
check reports zero errors and warnings, folder typecheck passes, and the
canonical Vite build passes. Browser evidence is recorded above.
