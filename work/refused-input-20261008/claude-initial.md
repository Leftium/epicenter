**Recommendation: remove Whispering's held typed values and rely on the native refusal.** When structured input is refused, the control goes back to showing `editor.row` within the same task. Add one small piece of app state, a refusal notice, so the person can see why their typing disappeared. That notice must not count as unsaved work. The native `RowEditor` needs no changes. Source repair, failed-save retention, unknown fields, newlines, the fences and retired controls all stay as they are.

## Files read

```txt
.agents/skills/
|-- adversarial-review/SKILL.md
`-- post-implementation-review/SKILL.md
packages/folder/src/
|-- editor.ts
|-- canonical.ts
|-- file-browser.ts                 (withFileNewlines only)
`-- svelte/row-editor.svelte.ts
packages/ui/src/
|-- input/input.svelte
`-- textarea/textarea.svelte
node_modules/.bun/svelte@5.56.3/.../client/
|-- dom/elements/bindings/input.js  (bind_value)
`-- reactivity/props.js             (bindable setter/getter)
apps/whispering/src/
|-- lib/
|   |-- row-editing.svelte.ts
|   |-- row-editing.test.ts
|   |-- row-slot.test-support.ts
|   |-- library.svelte.ts           (670-779, 1120-1174, 1370-1409, 2270-2394)
|   `-- transformations.test.ts     (400-470)
`-- routes/
    |-- svelte-dom.test-support.ts
    `-- components/
        |-- FileView.svelte
        |-- RecordingDetail.svelte
        |-- TranscriptCard.svelte
        |-- TransformationDetail.svelte
        |-- RowSaveStatus.svelte
        `-- row-views.mounted.test.ts (340-399, 630-733)
apps/todos/src/
|-- lib/todo-editor.svelte.ts
`-- routes/components/TodoDetail.svelte
docs/adr/0507-editor-views-compose-current-input-and-own-only-interaction-state.md (30-69, plus grep)
```

I did not read `TodoStatus.svelte`. You said it is unrelated dirty work, and I haven't assumed anything about it.

## Does the control actually show the old value? Yes, one microtask later

In Svelte 5.56.3, `bind_value` (`input.js:22-64`) works like this:

1. `set(input.value)` runs.
2. Then `await tick()`, which is `Promise.resolve()` followed by `flushSync()` since async mode is not enabled for Whispering.
3. Then `if (value !== (value = get())) input.value = get()`, restoring the selection clamped to the new length.

The binding is nested: the app's function binding feeds the `@epicenter/ui` Textarea or Input, which feeds the DOM element. The UI component's `writeValue` assigns the bindable prop. `props.js:370-384` turns that write into a call to the parent setter, and every read calls the parent getter. So `readValue()` returns the app getter's current value, which is `editor.row`.

Consequences:

- **The setter refuses, the row is unchanged, and the DOM shows the row again before the next user event.** Events are separate tasks, so no keystroke can arrive in between.
- **This doesn't depend on focus.** The "never rewrite a focused input" skip (`input.js:89-101`) only applies inside the render effect. The post-tick check writes regardless of focus.
- **A refused value always differs from the accepted one.** A valid row's strings and body are well formed (`canonical.ts:101,148`), and the only realistic structured refusal is a lone surrogate (`row-editing.svelte.ts:21-22`). So a refused value can never equal the getter's value, and the revert always fires.
- **No secretly unsaved text.** After the revert, every structured control shows the `row`. The `row` is either saved or visibly saving, failed, unconfirmed or removed.
- **The revert goes back to admitted input, not to disk.** After a failed save, `row` is still the failed input (`editor.ts:22-23, 459-466`). A refused paste then puts the control back on that input, and the failure line stays.

**Trap for the evidence:** the existing mounted tests do `type(); flushSync(); expect(value)` (`row-views.mounted.test.ts:372-376`). That reads the DOM before the revert happens. Revert tests must wait at least a macrotask, for example `await new Promise(r => setTimeout(r))`.

## Proposed shape

```ts
// row-editing.svelte.ts: what stays app-owned
let refused = $state.raw<string | undefined>(); // presentation only

set(next: CanonicalDocument) {
  const row = editor.row;
  if (!takes() || source || row.status !== 'valid') return undefined;
  const result = editor.set(next);
  refused = result.error === null ? undefined : refusalReason(result.error.refusal.reason);
  return result;
}
// setText (when taken), a successful reload, and release clear `refused`.
get holds() { return !released && editor.save.status !== 'idle'; }
get refused() { return refused; }
// status drops the 'refused' kind; showSource drops the SOURCE_HELD check.
```

```svelte
<!-- every body binding (FileView, RecordingDetail, TranscriptCard, TransformationDetail) -->
bind:value={
  () => editing?.row.status === 'valid' ? lf(editing.row.body) : '',
  (value) => {
    const row = editing?.row;
    if (row?.status === 'valid') editing?.set({ ...row, body: withFileNewlines(value, row.body) });
  }
}
<!-- the title and model bindings: the same, with `fields: { ...row.fields, title: value }` and no control -->
```

- **Newline handling moves into the binding.** With `withFileNewlines` there, the `control` option is no longer needed: no-control commands still save their body exactly, and textareas keep the file's CRLF.
- **The failure notice lives in `row-editing`, shown by `RowSaveStatus`.** It is one `role="alert"` line rendered above whichever status branch is showing, so it never replaces a failed or saving line. `TranscriptCard`'s `unsettled` (`TranscriptCard.svelte:50`) has to add `|| editing.refused`, or the card won't show it.
- **The notice is excluded from `holds`, `status`, `saveProblems` and `unsavedWork`.** It describes something that was already put back, not unsaved work.

## Guarantees kept, and who owns them

| Guarantee | Owner | Evidence |
|---|---|---|
| Accepted input survives a failed write | native `row` and `save` | `editor.ts:459-471` |
| Unknown fields kept; an omitted field is deleted | complete `set` from `row.fields` | `row-editing.test.ts:74-96` |
| Textarea body saved in CRLF; command bodies saved exactly | `withFileNewlines` in the binding | `row-editing.test.ts:98-130` |
| Source repair keeps malformed or unencodable text | native `setText`; `Unencodable` makes the save fail | `editor.ts:318-323, 451-455` |
| Fences: admits, reload, release | `takes()` | `row-editing.svelte.ts:205` |
| Retired controls deliver nothing | UI `live` flag plus `LiveButton` | `textarea.svelte:15-26` |

The reload fence (`reloads`) was previously required because a refused set never bumps `inputRevision`. A successful reload would therefore wipe out freshly held text; `todo-editor.svelte.ts:321-322` says this outright. Without held values, native `InputChanged` already protects admitted input, so the fence becomes a product choice. I'd keep it, since you listed it as something to preserve.

## Promises being dropped (all follow from your decision)

- Keeping a refused typed value in its own control: `Held`, `hold`, `held`, `dropRefused`, and the per-control Discard buttons.
- `HeldInput`, which blocked other controls and commands that would change a held value, along with `same()` and `isList`.
- Blocking Source while a value is held (`SOURCE_HELD`).
- Blocking close, leave, move, settle and transform while a value is held: `holds`, `settleDraft:697`, `unsavedWork:1394`, `saveProblems:2305`, and the `transformations.test.ts:430-450` behaviour. The replacement guarantee is stronger: what a control shows is always what settling sends.

## Deletion prize

- **`row-editing.svelte.ts`:** about 110 of 395 lines go: `Refused`, `Held`, `NONE`, `Control`, `RowEditingError`, `same`, `hold`, `holding`, `dropRefused`, the `control` parameter, the `refused` status kind, and the held clauses in `holds`, `showSource`, `reload` and `release`.
- **Bindings:** seven getters lose `held…?.value ??`, and seven setters lose `{ control }`.
- **`RowSaveStatus`:** the refused branch with its discard loop becomes one line.
- **`library.svelte.ts`:** two `'refused'` cases go, and the `settleDraft` and `draftHolds` docs need updating.
- **Tests:** `row-editing.test.ts:260-377` collapses into one test; three mounted tests (`364-392`, `634-676`, `678-732`), `desktop-sequences.test.ts:383-409` and `library.test.ts:3129-3145` get rewritten; `fieldShown` and `bodyShown` simplify.
- **Same deletion available in Todos (comparison only):** `refusals` in `todo-editor.svelte.ts`.

## Complexity introduced and costs

- One `$state`, its clearing rules, one status line, and the `TranscriptCard` condition.
- **The whole paste is lost on refusal.** It stays in the clipboard, but a programmatic `input.value` write usually also breaks native undo for that field.
- The caret is clamped to the old offset rather than the paste point.
- Source and fields now treat a lone surrogate differently: Source keeps it as invalid input with a failed save, while fields put the control back. That's intended, but it should be written down.

**Alternatives I rejected:**
- A native snapshot `refused` fact: it would change the package contract just for presentation.
- A toast in each binding: every future binding would have to remember it, and the row-editing tests can't observe it.
- `toWellFormed()` auto-repair: it writes U+FFFD, which the person never typed.
- Falling back to `setText` with an escaped value: it writes a non-canonical file because of a paste glitch.

## Tests that separate the designs

1. **Revert in mounted tests:** a lone surrogate in the title, body, prompt and transcript card, then wait a macrotask. Expect `value === row`, `data-save-state` unchanged, the notice visible, `holds === false`, and the file unchanged.
2. **Revert to admitted input, not disk:** first a failed write over the desktop adapter, then a refused paste. The control shows the failed input and the failure line stays. This is the test that catches revert-to-disk.
3. **CRLF file:** a refused body edit shows `lf(row.body)`, and the next valid typing saves as CRLF.
4. **Nothing to block:** after a refused paste, leave, close and move all proceed, and transform sends the shown body.
5. **Source:** a lone surrogate typed in Source is still retained, fails with `Unencodable`, and `holds` blocks leaving.
6. **Retired control:** typing there sets no notice and changes no row.
7. **Pin the Svelte behaviour:** a test that fails if `bind_value` stops calling the getter after the setter.

## Open conditions

- **Amend ADR 0507 for Whispering only.** Lines 38-48 and 159-161 make held input a shared rule, and Capture's rich-text codec refusals can't be put back through a DOM binding.
- **No real-browser or IME proof yet.** jsdom has no IME or selection. Before claiming the behaviour, run a scripted `input.value` plus `input` event in the real webview.
- **Reload fence:** keep it, as you asked; it is now a product choice rather than a safety mechanism.
- **Newline reference differs between apps:** Todos converts against `row.text`, Whispering against `row.body`. Pick one.
- **Fenced keystrokes:** I recommend no notice when a keystroke is refused because input isn't admitted. The `readonly` attribute is already the visible signal.