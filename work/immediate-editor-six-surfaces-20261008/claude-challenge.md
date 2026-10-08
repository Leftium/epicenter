No data-loss case I found blocks deleting only `pendingText`, provided the Source route stays free of codec checks and the notice can tell a codec refusal apart from the other refusals. I found one browser-dependent case where text can be lost, and three requirements the proposal doesn't yet cover. On the rich-text no-op you're right and my first-round suggestion was wrong.

## Capture: deleting only `pendingText`

**Why rollback is safe here**
- Typing that gets refused never reaches the editor. The accepted body stays in the row editor, and a failed save keeps it there.
- The rollback really happens. `@epicenter/ui` Textarea binds `readValue`/`writeValue`, and while mounted `readValue` returns the parent's value (`packages/ui/src/textarea/textarea.svelte:20-36`). After the setter refuses, Svelte's check (`bindings/input.js:40-62`) sees `draft.text` differs from what was typed and rewrites the field, restoring the cursor.
- The codec still blocks source loss on the Capture tab. While a fence is open, closing it from the Capture text box makes the heading and thoughts reappear. `readsBack` then expects `thoughts: []` and refuses it (`document.ts:453-469,618-636`). Adding a thought is refused the same way.

**What deleting `pendingText` changes beyond codec rejection.** `inputText` also sets `pendingText` when `setCapture` refuses for reasons that have nothing to do with the codec:
- **An unconfirmed delete** (`undecided()`, `draft.svelte.ts:262-268`). `captures.test.ts:600-614` currently checks that typing after a thrown delete is kept, and applied after reload. After deletion that typing is rolled back and gone. That fits your rule, since it was never accepted, but:
  - that test has to be rewritten, not just trimmed;
  - the notice there must **not** suggest Source, because `inputSource` is refused by the same `undecided()` (`draft.svelte.ts:523`).
- **An invalid row** ("cannot be edited here now", `draft.svelte.ts:410-412`). The view can't reach this, but `draft.test.ts:274-276` calls it directly and must change.

So the refusal needs a kind, not just text. Offer the Source route only when `captureBody.encode` refused (`draft.svelte.ts:414-420`). A delete-hold refusal or an editor `Unrepresentable` refusal gets the plain reason only.

**The one data-loss case I found (rare, browser-dependent).** Dragging selected text to a new spot inside the same textarea fires `deleteByDrag`, then `insertFromDrop`, as two input events. If the delete is accepted and saved, and the insert is then refused, the moved text is gone from both the field and the file. There's no clipboard copy to recover it from. Example: drag `<!--` out of a closed `<!-- x -->` and drop it after the `-->`, where it opens an unclosed comment. With `pendingText` today, the second step would be kept instead. I'd accept this as a cost of the trade-off rather than a blocker. It needs browser confirmation that the two events and Svelte's rollback interleave as described. Cut then paste is fine, because the clipboard still has the text.

**Other costs that aren't data loss**
- Rewriting `input.value` on rollback clears or breaks the textarea's native undo history.
- Pasting a block with an unclosed fence rolls back the whole paste. The clipboard still has it.

**A presentation risk that the Source route makes more common.** After Source opens a fence, the body still decodes fine (`hasSection: false`, `thoughts: []`). So `sourceOnly` is undefined, the Capture tab stays enabled, and `CaptureDetail.svelte:390-393` says "This file has no Thoughts section yet." Meanwhile the old `## Thoughts` and `- first` lines appear as plain text in the Capture text box. A person who deletes those lines as clutter has their thoughts deleted and saved. This exists today too, so it doesn't count against deleting `pendingText`. But the design now sends people to Source for fences, so the test should pin this state down.

## The Source route that must stay
- **The Source tab:** disabled only while `held` (`CaptureDetail.svelte:196`). Keep it that way.
- **`setView('source')`:** blocked only by `fenced()` (`draft.svelte.ts:499-502`).
- **`inputSource`** (`draft.svelte.ts:522-533`): `fromTextarea`, then `editor.setText`, gated only by `undecided()` and `!editor`. No `captureBody.encode` or `readsBack` may be added to this path. The CRLF preservation in `fromTextarea` (`document.ts:373-406`) has to stay.
- **The forced switch:** the `$effect` (`CaptureDetail.svelte:59-61`) forces Source only when the body can't be decoded. That's correct; an open fence isn't a decode failure.
- **The notice:** add an "Edit in Source" button calling the existing `showSource()` (`CaptureDetail.svelte:127-131`), shown only for codec refusals.

**Suggested notice copy (codec refusal):**
> **Not applied.** {encode reason, e.g. "This text would not read back as written. Markdown around it, such as an unclosed code fence or HTML comment, would absorb or change it."} The capture text is back to what is saved. To write Markdown that is unfinished while you type it, edit it in Source.
> [Edit in Source]

For an unconfirmed delete, keep the existing reason with no button: "The delete was not confirmed. Choose what happens to this capture first."

**Other places that need edits**
- `saveCopy`'s message (`captures.svelte.ts:554-558`) drops "capture text that could not be applied".
- `hasUnsentInput` becomes `newThought !== '' || editing !== undefined`.
- Replace `draft.test.ts:314-323`.

**What the test must prove**, using `canon('A', '- first\n- second\n')`:
1. **Rollback:** `inputText('A\n```\nopen')` leaves `draft.text === 'A'`, the file unchanged, and `saving`, `unsettled` and `hasUnsentInput` all false. `refusal` contains "would not read back" and is the Source-repairable kind.
2. **Source accepts the unfinished body:** `setView('source')`, then `inputSource(...)` putting the open fence into the text. After `settle()` the file matches exactly, `status === 'valid'`, `document.refusal === undefined`, `hasSection === false`, `thoughts` is `[]`, and `refusal` is cleared.
3. **The codec still protects the source while the fence is open:**
   - `addThought()` returns false, keeps `newThought`, and leaves the file unchanged;
   - an `inputText` that closes the fence is refused with the file unchanged.
4. **Repair in Source:** closing the fence via `inputSource` gives `thoughts` equal to `['first', 'second']` and `hasSection: true`, with the file matching exactly. Add a CRLF variant to show untouched line endings survive.
5. **Unconfirmed delete:** after a thrown delete, `inputText` rolls back, the reason says "not confirmed", it is not the Source-repairable kind, and `inputSource` is also refused.
6. **DOM rollback:** one component-level check that, after a refused input and a tick, the native textarea's value equals the accepted text. The draft-level tests can't prove the binding does this.

## Rich-text no-op gate
- You're right. My first-round suggestion (return `next` in `stateAfter` before `set`) would show an edit on a released or fenced editor, or one waiting on a path change. That breaks `rich-text.ts:15-16`: nothing is shown that the editor would not take.
- Keep the no-op inside `set`, after `blocked()` and the valid/raw check (`note-editor.svelte.ts:208-212`).
- With `refused` deleted, the `control` option exists only for this no-op. Replace it with `if (next === row) return undefined;` for every caller and delete `control`. `withBody` returns the same row object when the body is unchanged (`note-source.ts:29`). The body Source control (`NoteDetail.svelte:184`) also goes through `withBody`, so an identical value there now skips the save instead of saving again. That's harmless; `retry` covers re-saving.
- **Leftover gap:** `stateAfter` encodes and calls `editor.refuse(error)` before any admission check (`rich-text.ts:202-205`), and `refuse()` itself is ungated (`note-editor.svelte.ts:348-350`). On a fenced editor, a rich edit with no Markdown form shows the codec reason rather than the fence reason. Check admission at the top of the document-change branch in `stateAfter`, or have `refuse()` return early when `blocked()` is set.

## How long the field-refusal notice lives
- **Todos and Vocab need a new piece of state.** Their callers throw away the return value: `TodoDetail.svelte:84,149` ignore what `todo.set` returns, and `EntryCard.svelte:123` ignores `inputNote`. The reason is currently shown only through the overlays you're deleting (`TodoStatus.svelte:39-56`, `EntryCard.svelte:126-130`). Without one `refusal` field each, rollback would be silent. Honeycrisp already has `refusal`.
- **What sets it:** only a codec or `Unrepresentable` refusal. Fenced keystrokes already roll back silently today and have their own UI; showing them as notices would be noise.
- **What clears it:** the next accepted input to that editor (including the rich-text no-op), a successful reload, and release. Honeycrisp's `accepted()` already covers retry and `saveHere`.
- **What it must not do:** count toward `unsettled`, `isIdle`, `hasProblem`, `status`, `flushed`, close, departure, or the reload/view-switch checks. If it did, it would rebuild the refusal-only gates you're removing.
- **Copy:** it must say the change was undone, e.g. "Not saved: {reason}. The field shows the saved text again." Remove "Your typing stays in the field until you fix it" (`TodoStatus.svelte:56`) and "It stays in the field until you correct it, discard it…" (`EntryCard.svelte:129`).
- **Line-ending regression to avoid in Todos:** the CRLF restore for notes depends on `control === 'notes'` (`todo-editor.svelte.ts:143-146`). Deleting `control` must move `withFileNewlines` to the notes binding, as Honeycrisp (`NoteDetail.svelte:184`) and Vocab (`word.svelte.ts:303`) already do. Otherwise notes get written with LF and a CRLF file's line endings are rewritten.

## Still open
- Whether the drag-move case loses text in practice (Chrome's two input events plus Svelte's tick timing). Only a browser test settles it.
- Whether to also clear the field notice when switching views (`editSource`/`editFields`/`showFile`). If not, a notice can reappear when an editor kept per path is reopened. That's cosmetic.

I didn't make edits, run commands, or start child agents.
