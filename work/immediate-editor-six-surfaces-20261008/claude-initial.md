I'd build one rule for all six surfaces. The row editor's accepted content is the only content. A control always shows it. Each change goes to the editor immediately. If the editor refuses the change, the control goes back to the accepted value and shows one short message. If a save fails, the editor keeps the accepted content.

Most of the code needed is already in place. The work is mostly deletion, plus one real fix in Matter. There is one exception: the Capture text box still has to keep text it couldn't apply.

## Files read (baseline 17724f7fd6, read-only)
```
apps/
├─ todos/src/lib/todo-editor.svelte.ts
├─ vocab/src/lib/word.svelte.ts
├─ honeycrisp/src/
│  ├─ lib/note-editor.svelte.ts
│  ├─ lib/editor/rich-text.ts
│  └─ routes/components/RichEditor.svelte
├─ capture/src/lib/
│  ├─ draft.svelte.ts
│  └─ components/CaptureDetail.svelte
├─ matter/src/lib/
│  ├─ components/MarkdownBodyEditor.svelte
│  ├─ components/RowDetailDialog.svelte
│  └─ table.svelte.ts            (lines 120-199: write / saveField / saveBody)
└─ skills/src/lib/components/editor/CodeMirrorEditor.svelte
packages/
├─ capture/src/document.ts
└─ folder/src/
   ├─ editor.ts                  (lines 60-241: error kinds, RowState, SaveState, RowEditor)
   ├─ canonical.ts               (grep of refusal reasons only)
   └─ svelte/row-editor.svelte.ts
node_modules/.bun/svelte@5.56.3/.../bindings/input.js   (grep: how bind_value restores the control)
```
I also searched the apps for callers of `refused`, `refusals`, `refusedNote`, `textIsPending` and `refuse(`.

## Two facts the design rests on
1. **For plain text fields, a refusal practically never comes from typing.** `RowSetError` is only `Unrepresentable` (`packages/folder/src/editor.ts:146`). For a string field or body, the only canonical refusal is a lone surrogate (`canonical.ts:150,257,363`). That takes a malformed paste, not typing.
2. **Svelte already puts the control back for free.** With function bindings, after the setter runs Svelte calls `await tick()`, then rewrites `input.value` if `get()` differs, and restores the cursor (`bindings/input.js:40-62`). If the setter refuses and the getter returns the accepted value, the control reverts by itself. No held copy is needed.

## The design, surface by surface
**Shared shape:** getter = the accepted value in the form the textarea reports (LF line endings). Setter = `editor.set(...)` immediately. A refusal sets one short `refusal` message, cleared by the next accepted input. A failed or unconfirmed save is the native `SaveState` (input kept, error shown, retry, explicit reload), as today. A refused value is no longer "unsaved", so rename, delete, close, departure, reload and the Source toggle stop checking for it.

- **Todos:** drop the `refusals` map, `RefusedField`/`Refusal`, the cross-field `held` check and the `{control}` option. `set` keeps `blocked`, the valid/raw-mode check, the newline restore for notes, and returns the message.
  - `flushed`, `isIdle` and `hasProblem` look only at `save`.
  - `editSource` loses its refused-value block, and `reload` loses the reason for its fence.
  - In `TodoDetail.svelte:81,146` the getters drop `todo.refused.x?.value ??`. `TodoStatus.svelte:39-56` shows the short `refusal`.
- **Vocab:** drop `refusedNote`, `discardRefusedNote`, `REFUSED_NOTE_HELD`, the check in `reload` and the term in `unsettled`. `note()` becomes the editor's note or the listed one. `EntryCard.svelte:126-130,174` simplifies.
- **Honeycrisp:**
  - Drop `refused`, `TypedField`, the `held` check, the refused block in `showFile`, the clearing in `release`, and the `'dirty'` case in `status`.
  - Drop the `notes.svelte.ts:1160` check and the refused list in `RowDraftStatus.svelte:50`.
  - Keep `refusal`/`refuse()`.
  - Delete the `control` parameter entirely: in `stateAfter`, return `next` when `body === row.body`, before calling `set`. That covers the empty paragraph Markdown can't write.
  - Rich text already works this way: a refused transaction leaves the ProseMirror state unchanged, and `stateShowing` resets history when the body changes.
- **Capture:** the Source tab and structured edits stay as they are (immediate, row-editor owned). **Keep `pendingText` for the Capture text box** (see the typing cases below). Keep `newThought` and `ThoughtEdit` as explicit Add/Save fields.
- **Matter — the only real change.** Today the body is written only on blur or teardown (`MarkdownBodyEditor.svelte:86-90,113,126`). `committed` is advanced *before* `onCommit`. A failed `write` only sets `writeError` (`table.svelte.ts:172-174`). So after a failed save, closing the dialog or switching rows loses accepted text, and nothing resends it. That breaks your "accepted but unsaved content must remain" rule. Proposed fix:
  - Add an `unsaved: SvelteMap<fileName, body>` in `table.svelte.ts`. Set the entry on every CodeMirror change. Delete it only when a write of exactly that body lands.
  - Give body writes one running and one latest waiting per file, instead of `serializeWrite`'s unbounded chain. Field writes still share the same per-file order.
  - The editor shows `unsaved.get(f) ?? row.body`. When that value differs from the editor's text, it replaces it (cursor resets, which you accepted).
  - Remove the blur/teardown commit. Reopening the dialog after a failure shows the kept text; add a Retry button next to `writeError`.
- **Skills:** nothing to simplify. A Yjs local apply can't be refused or fail, writes are already immediate, and remote updates replace the text (cursor reset accepted). Two separate defects, outside this work:
  - Every keystroke replaces the whole text (`CodeMirrorEditor.svelte:48-50`), so two peers editing at once get duplicated text.
  - Remote dispatches go into undo history, so Ctrl-Z can undo a peer's edit.

## What must be kept for this to be worth adopting
- The native `RowEditor` as the only owner of content: input kept on failure, `retry`, `reload` with `InputChanged`, no automatic adoption of other writers' changes.
- Every lifecycle guard as is: fences, `released`, `departing`, `pathChange`/`hold`, Capture's operation hold and deletion review, Vocab's `deletion`/`goneOnRead`.
- Getters that return exactly what the textarea reports (`lf()`/`toTextarea`). Otherwise Svelte rewrites `input.value` on every keystroke in CRLF files.
- Capture's `pendingText`, and explicit commit for thoughts.
- Honeycrisp's "show nothing the editor didn't accept", and rebuilding the rich-text state when the body changes.

## Deletion prize
- Roughly 60 lines in Todos, 25 in Vocab, and 45 in Honeycrisp's editor, plus refused-value branches in `TodoDetail`, `TodoStatus`, `EntryCard`, `NoteDetail` (title/body getters), `RowDraftStatus` and `notes.svelte.ts`. Also the refused-field tests, and the `{ control: 'title' }` text in `apps/todos/README.md:436`.
- The bigger win is removing a concept from three apps: "a refused typed value counts as unsaved and blocks rename, delete, close, reload and switching views".

## New complexity
- One `refusal` message field each in Todos and Vocab. Honeycrisp and Capture already have one.
- About 40 lines in Matter: the unsaved map, the latest-waiting slot, and following the shown value.
- Nothing new in Honeycrisp's rich text, Capture or Skills.

## Ordinary typing cases
1. **Capture text, typing ` ``` `, `<!--`, an HTML block, `## Thoughts`, or a `---` underline.** Each in-between state is refused as `unverified` or `duplicate-heading` by `readsBack`. If the box reverted, these could never be typed. This is why Capture keeps `pendingText`.
2. **Capture thoughts.** `normalizeThought` trims blank edges, so an immediate write would revert every trailing space or newline. Thoughts keep explicit commit.
3. **CRLF files.** If a getter returns `\r\n` text, Svelte's comparison fails on every keystroke. Each mismatch rewrites the value, which interrupts IME composition and clears the textarea's undo history.
4. **Pasting a lone surrogate into a title or note.** The whole paste reverts, the cursor goes back to its offset, and the message shows. Acceptable.
5. **Honeycrisp rich text, pressing Enter at the end.** The empty paragraph has no Markdown form, so the state is shown without calling `set` (keep this).
6. **Typing during a reload.** The native editor returns `InputChanged` and the input stays. Typing after a failed save saves again, and the error banner stays until a save succeeds.
7. **Vocab, typing before the editor opens.** The setter takes nothing and the field reverts to the listed note, as it does today. The editor must open on focus.
8. **Matter, typing while a write is running.** It waits in the latest slot. The shown value masks older echoes while unsaved text exists.

## State that must stay separate
- The native row editor's input and save state (the only content).
- The raw/fields view choice (Todos, Honeycrisp, Capture).
- Lifecycle fences, holds, path changes, Capture's deletion state, Vocab's deletion state.
- One short `refusal` message per editor.
- Capture's `pendingText`, `newThought`, and `ThoughtEdit` (the edit tied to the parse it came from).
- Honeycrisp's ProseMirror state (cursor and history).
- Matter's new per-file unsaved body.

## Open questions and evidence needed
- **This reverses a recent decision.** Commit `f567c5be12` is "docs: record refused-input review and acceptance". I didn't read that doc. Check it, and ADRs 0253/0457, so dropping refused-text retention is a deliberate reversal.
- **Matter watcher:** does an echo carry the file's bytes at delivery or at event time? If at event time, an echo of an older write arriving after the latest one landed would revert the editor to stale text. If so, freeze following while the dialog is open.
- **Capture's `Textarea`** (`@epicenter/ui/textarea`) must pass the function binding through so Svelte's revert reaches the native element. A one-line test settles it: a refused set restores the DOM value.
- **Skills:** applying CodeMirror changes to Yjs as minimal changes, and keeping remote dispatches out of undo history, are separate fixes.
