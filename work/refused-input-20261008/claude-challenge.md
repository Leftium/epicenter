I found no counterexample that breaks the two cases you asked about. A refusal notice next to an older save failure, and a notice that outlives an earlier save completing, both behave correctly. I found three smaller problems: a reload you don't count as a discard can clear the notice, a repeated refusal isn't re-announced, and the notice wording must not say "saved." For the mounted rollback tests, wait for the next task rather than `await tick()`. My first verdict stands.

## The two cases you asked about

The notice and the save state can't interfere because the native editor's `commit` only replaces `row` and `save` (`editor.ts:373-378`), and a write finishing only touches `save` (`editor.ts:459-471`). Neither can reach the app's `refused` state.

- **Notice next to an older failure:** write A fails, so the save shows failed. You paste a lone surrogate: it's refused, the notice appears, and the control goes back to A, the failed input, not the disk text. Then:
  - **Save again** succeeds: the status becomes Saved and the notice stays. That's accurate, because the paste still wasn't kept.
  - **Discard mine** succeeds: both the failure and the notice clear, which is correct.
- **Notice outliving an earlier save:** A is accepted and its write is running. A paste is refused and the notice appears. Then A's write finishes, as idle or failed, and the notice stays. That's correct.

The same holds when B is queued behind A: the row is B, the control goes back to B, and when the queued write finishes the notice stays.

## Corrections

1. **Wording (medium).** The control goes back to the latest input the editor accepted, which may still be saving or may have failed. So the notice must not say "saved text" or "the file," and must not say "not saved." Otherwise it contradicts a Saved line after Save again, or a failure line. Something like: "What you typed was not kept: ‹reason›. The field shows your last kept edit."

2. **A non-discard reload clears the notice (low).** `observeRecording` reloads a kept recording editor whenever `!holds` (`library.svelte.ts:1449-1450`). It runs from `show` for a pending capture (`library.svelte.ts:1502`). Under the old design, a held value made `holds` true, so this reload never ran over it. Under the new design, a refused title paste followed by that capture observation clears the notice even though the person never addressed it. Nothing is lost, since the control has already gone back. Pick one rule:
   - clear only in the person's reload path (`reloadRow`, `library.svelte.ts:823`, which Discard mine also uses), or
   - write down that any successful reload clears it.

   I'd go with the first.

3. **A repeated identical refusal isn't re-announced (low, accessibility).** A second refused paste with the same reason sets `refused` to an identical string. Nothing in the DOM changes, so the `role="alert"` isn't re-announced, even though the text vanished again. To fix it, store a fresh object for each refusal and render the alert with `{#key editing.refused}`. Clearing still happens only on successful input, a reload, or release.

## Mounted rollback tests: wait for the next task

`await tick()` happens to work today, but only because of microtask order. The handler's own `tick()` starts first, inside the synchronous `dispatchEvent`, so its rollback continuation is queued before the test's continuation. In async mode, though, `tick()` races `requestAnimationFrame` against `setTimeout` (`runtime.js:495-502`), and that ordering argument stops holding. Waiting for the next task covers both modes, because the handler's timer was queued first:

```ts
type(title(), 'Half \uD800');
await new Promise((resolve) => setTimeout(resolve, 0));
expect(title()?.value).toBe(rowTitle);
```

Don't assert the in-between "still typed" value; that just pins Svelte's internal timing.

## Real-browser fixture: one guard to add

Before dispatching `input`, have the fixture assert `!control.value.isWellFormed()`. If Chrome cleaned the assignment up to U+FFFD, the input would be accepted and saved rather than refused, and the fixture would look like it passed while testing nothing. After dispatching, assert:

- the control shows the latest accepted input again
- the notice is visible
- `data-save-state` hasn't changed
- the file's bytes haven't changed

The case with an earlier failed save belongs in `desktop-sequences`, where writes can be made to fail.

## Still open from earlier

The paste's undo history is lost after the control goes back, and the caret position is clamped to the shorter text. Neither changes the verdict.