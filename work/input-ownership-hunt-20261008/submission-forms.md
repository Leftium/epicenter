# Submission forms: Vocab and Whispering

Read-only hunt on 2026-10-08. No application files were changed, and no UI
acceptance was performed. Findings below are source-traced; a proposed fix still
needs the focused checks named with it.

## Files read

```text
.agents/skills/svelte/references/input-ownership.md
apps/
|-- vocab/
|   |-- README.md
|   `-- src/
|       |-- lib/
|       |   |-- import.ts
|       |   |-- import.test.ts
|       |   `-- chat/
|       |       |-- session.svelte.ts
|       |       `-- session.test.ts
|       `-- routes/components/
|           |-- AccountMenu.svelte
|           |-- EntryCard.svelte
|           |-- EntryCard.test.ts
|           |-- PhraseCapture.svelte
|           |-- VocabShell.svelte
|           `-- WordsView.svelte
`-- whispering/
    |-- AGENTS.md
    |-- README.md
    `-- src/
        |-- lib/
        |   |-- connections.ts
        |   |-- home-controls.test.ts
        |   |-- library.svelte.ts
        |   |-- settings-draft.svelte.ts
        |   `-- terminal.svelte.ts
        `-- routes/components/
            |-- ConnectionForm.svelte
            |-- FileBrowser.svelte
            |-- FileNameBar.svelte
            `-- TransformationList.svelte
```

Large owner/test files were read at relevant sections, not audited in full.
Searches also inspected state/submission matches in both app source trees.

## Grounded changes worth implementing

### 1. Vocab import review has split draft state and a late-result overwrite

`apps/vocab/src/routes/components/WordsView.svelte:25-27,33-35,59-64,88-103`.

`review` holds the eligible input and its counts; `selected` independently holds
the subset to submit. `confirmImport` awaits the submitted selection, then changes
whatever review and selection are current. While it waits, Browse starter list,
Review paste, Cancel, and every selection checkbox remain available. Opening a
second review or changing its selection can therefore be overwritten when the
first submission finishes. The actual first submitted array is stable because
checkbox edits replace it, but the completion does not address that submission.

Current shape:

```ts
let review = $state<Review | null>(null);
let selected = $state<string[]>([]);
async function confirmImport() {
  if (adding) return;
  const failed = await add(selected);
  if (failed.length === 0) review = null;
  else selected = failed;
}
```

Proposed shape, with one unfinished import draft:

```ts
type ImportDraft = ReturnType<typeof reviewImport> & { selected: string[] };
let review = $state.raw<ImportDraft | null>(null);
function openReview(raw: string) {
  const next = reviewImport(raw, savedTexts());
  review = { ...next, selected: [...next.eligible] };
}
// Checkbox edits: review = { ...review, selected: nextSelected }.
async function confirmImport() {
  if (adding || !review) return;
  const submitted = review;
  const failed = await add(submitted.selected);
  if (review !== submitted) return;
  review = failed.length ? { ...submitted, selected: failed } : null;
}
```

The sketch's `savedTexts()` stands for the existing expression building a Set of
entry texts, not a recommended new helper. Keep it inline in implementation.

Deletion prize: one independent rune and the open/reset synchronization between
two variables. No new reset effect, ticket, or submission mirror is needed.
Preserved information: eligibility/counts, checkbox selection, failed items,
pasted text kept while hidden, and typing or review changes made during a save.
The API still receives the selected string array because review counts are UI
information, not part of `entries.add` input.

Focused verification: mount the actual WordsView with deferred additions. Submit
A, open B, resolve A with success and with a partial failure, and verify B and its
selection survive. Also change selection within A while saving, cancel while
saving, and verify unchanged submissions still clear or retain only failed items.
Then exercise paste/review/add through computer use. Existing `import.test.ts`
covers parsing only; it does not cover these async UI lifetimes.

### 2. Vocab focus submission can erase a newer selection

`WordsView.svelte:66-71`, its EntryCard props near line119, and
`EntryCard.svelte:89`. `VocabShell.svelte:60-78` awaits saving the focus and then
shows the new chat. Only Start and Clear are disabled while `starting`; card
checkboxes remain enabled. `start()` clears current `focusIds` after its submitted
focus succeeds, even if those IDs changed during the wait.

Current and proposed:

```ts
// Current
const focus = selectedFocus.map(({ id, text }) => ({ entryId: id, text }));
if (focus.length && await onStart(focus)) focusIds = [];

// Proposed: selection writes already replace the array.
const submitted = focusIds;
const focus = selectedFocus.map(({ id, text }) => ({ entryId: id, text }));
if (focus.length && await onStart(focus) && focusIds === submitted) focusIds = [];
```

This is a correctness alignment, not a large deletion. Preserve the focus snapshot
saved with the chat and later selections intended for a different chat. No need
to combine selection with search/filter/input state. Verify with deferred
`onStart`: select A, Start, choose B during the wait, finish A, return to Words and
confirm B remains. An unchanged selection should clear after success; failure
should retain it. No new counter is needed.

### 3. Whispering inline filename completion can close a newer form or discard newer typing

`apps/whispering/src/routes/components/FileBrowser.svelte:35-40,62-65,87,151-184,195-224`.
The Enter/blur `committing` flag deduplicates submissions, but it does not make
their completions address the form they submitted. A commit captures `editing`,
awaits a rename/create, then clears current `editing` and takes focus. Meanwhile
Escape can cancel, New file/folder and Rename menu actions can open another form,
and the current input remains editable. Old success closes the replacement form;
typing into the original field while its save runs is also discarded by closing
it. The field stores that typing only in the DOM, so comparing `editing` object
identity alone would protect new forms but miss edits within the same field.

Current completion:

```ts
const current = editing;
// ... await the captured operation ...
editing = undefined;
onOpen(/* old created file */);
await tick();
focusRow(/* old submitted path */);
```

Use one explicit draft containing both the name and operation. Every name edit
and new-form action replaces it. Capture it at submission and dismiss/move focus
only if it is still current:

```ts
type NameDraft =
  | { kind: 'rename'; path: string; name: string }
  | { kind: 'create'; directory: string; type: 'file' | 'folder'; name: string };
let editing = $state.raw<NameDraft | undefined>();
// Each name edit: editing = { ...editing, name }.
const submitted = editing;
// ... await operation(submitted) ...
if (editing !== submitted) return;
editing = undefined;
// Only now dismiss, navigate, and move focus for this form.
```

This is ownership pseudocode; render the form only for a present draft and narrow
the current value in callbacks. Keep the global in-flight operation flag so
Enter/blur cannot submit twice, failure reporting, and the actual saved result
even if its form is no longer current. A successful operation should still
refresh the listing. After a pending rename succeeds, its old source path no
longer exists: decide whether newer typing continues against the new path or
closes with an explicit receipt. This address-following question is separate
from the grounded new-form overwrite and new-file typing loss.

Deletion prize: remove the split between operation identity in a rune and
unfinished text only in the DOM. One replace-only draft identifies exactly what
was submitted without a separate revision counter. Preserve unfinished names,
destinations, old operation receipts, retry text, and newer forms.

Focused verification: hold `createFile`, submit A, type A2, resolve A and inspect
the field. Repeat with Escape followed by opening B, on success and failure of
A. Verify late completion does not close B or steal its focus; Enter plus blur
still sends one operation. Exercise real menus, Escape, typing, and focus with
computer use. Existing rename-body mounted checks concern file-content editing
during a rename, not this inline name-form lifecycle.

## Policy-dependent candidates

### Whispering connection draft could become one object, but cannot be collapsed mechanically

`apps/whispering/src/lib/settings-draft.svelte.ts:59-80,99-131,143-155` and
`ConnectionForm.svelte:21,74-110`. The current owner exposes four field accessor
pairs and derives a `ConnectionChange` from separate base URL/model/key-action/key
values. An object draft could remove these forwarding pairs and make submission
capture more direct:

```ts
let input = $state.raw({ baseUrl, model, keyAction, key: '' });
// bind:value={() => owner.input.model,
//   model => owner.set({ ...owner.input, model })}
const submitted = input;
await library.saveConnection(operation, toConnectionChange(submitted));
```

This is shape pseudocode, not a patch recommendation as written. The API's key
union is deliberately different from the editable form: keep/replace/remove,
blank replacement normalization, and a key that cannot be read back. Retain that
mapping rather than inventing an identical payload claim. Session ownership is
also real: header and recorder forms share unfinished input.

Existing `home-controls.test.ts:202-375` requires canonical saved values to flow
back, typed-key preservation, rejection of keeping a key at another endpoint,
and unsaved edits surviving another connection's save. Writable derived values
currently reset when their configured primitive changes. A single object initialized
once would change that policy; a reset effect could destroy the intended collapse.

There is also an unverified late-reset concern: inputs remain enabled while Save
runs, and the configured base URL/model can change when its receipt arrives.
Tests cover newer key typing, but not newer base URL/model typing during a save.
Before implementation, add or run a deferred-save experiment for those fields
and decide whether receipt normalization resets only unchanged submitted input.
Keep device-only key storage, read-only connections, endpoint validation,
legacy-key adoption, and shared-owner lifetime intact. Never put the stored key
into this draft; the page cannot read it.

### Whispering filename form follows its live name

`FileNameBar.svelte:21-32` uses writable `$derived(name)` as its single unfinished
name. This is already a scalar explicit form. Changing it to mount-time `$state`
would stop the successful rename from showing its canonical new name; keeping
the derived reset can replace newer typing if the parent name changes during a
pending rename. Verify the actual parent/editor lifetime before choosing a reset
policy. There is no worthwhile object wrapper or field-accessor deletion here.

## Keep

- Vocab chat draft and submittedDraft: `chat/session.svelte.ts:42-44,77-83,232-264`.
  The draft survives a failed message save; the submitted value addresses the
  receipt and retry. `session.test.ts:220-232` already checks newer typing is kept.
  Removing submittedDraft would erase information about which draft was saved.
- Vocab single-expression input: `WordsView.svelte:53-57` already captures a scalar
  and clears only an unchanged successful submission. Search, stage, pasted
  source, focus selection, and request state have distinct jobs.
- Vocab phrase capture: `PhraseCapture.svelte:104-127` captures an exact phrase
  from a saved message and uses a candidate ticket to keep an old result from
  owning a newer popover. Its source identity and selection are not duplicate
  form fields. The same source is revalidated at submission.
- Whispering FileBrowser's Enter/blur remains explicit submission; replacing it
  with immediate filename writes would change the operation. Its completion
  lifetime is a grounded change above, not protected by deduplication alone.
- Whispering terminal's command, output, history, cursor and pending command are
  session data (`terminal.svelte.ts:22-96`). Clearing the input at dispatch is
  intentional: the command remains in output/history even when execution fails.
- TransformationList sends an explicit chosen starter, with a request flag, and
  has no editable content draft to collapse.
- AccountMenu email/profile loading is request/UI data, not an editing draft.

The known Whispering Source/Fields migration was excluded from this assignment;
its existing report remains the right place for that app ownership change.
