# Matter ownership review

Read-only Opus 5.5 session `512d439f-0038-45e8-bb94-f77102c5fa4b`; successful, no denials. This is an independent report, not accepted implementation.

I have enough to decide. Writing up the recommendation now.

## Recommendation

**The table handle should own accepted body text.** Add one `SvelteMap<fileName, string>` of unpublished bodies to `createTable`. The CodeMirror widget submits on every document change and seeds from `bodyOf(fileName)`, which returns the unpublished body if there is one and the store's body otherwise. Delete the blur and teardown commits and `submittedBody`.

A widget-only owner can't meet the requirement: the dialog unmounts and the text is gone. The dialog is the wrong owner too, because it is wrapped in `{#if detailConformance}` (`TableGrid.svelte:578`) and closes when its row disappears. The table handle lives in the vault's `tables` map for the vault's whole lifetime (`vault.svelte.ts:55,79`). It survives closing the dialog, switching tables (only `TablePane` is keyed) and save echoes. It is also the only place that serializes writes per file.

## What the current design guarantees, and where it fails

**What it gets right:**
- Save echoes can't reset typing. The editor is seeded once with `untrack` (`MarkdownBodyEditor.svelte:75`) and keyed on `fileName` (`RowDetailDialog.svelte:154`).
- Writes to one file are serialized as read-modify-write on fresh bytes (`table.svelte.ts:127-179`), so other processes' frontmatter edits survive.
- A teardown save goes to the editor's own file, because `{@const fileName}` captures it.

**Where it fails:**
1. **Close after a failed save loses the text.** `submittedBody` is set before the write's outcome is known (`:89`). `write` swallows the failure into `writeError` and always resolves (`:172-175`). Teardown then sees nothing new to commit, and closing destroys the only copy.
2. **A removed file comes back as a blank row.** The watcher deletes the row, so `detailConformance` becomes undefined and the dialog unmounts. If the editor was dirty, teardown calls `saveBody`. `read_entry` returns `null` (`entry.rs:42`), `edit(raw ?? '')` runs `parseMarkdown('')`, which returns `Ok({frontmatter:{}, body:''})` (`parse.ts:74`). `write_entry` then recreates the file as `---\n{}\n---\n<body>`. Immediate writes make this more likely, because a write can be in flight when the file is removed.
3. **Malformed frontmatter is treated as a successful save.** Suppose an outside edit breaks the frontmatter. `editBody` and `editField` return `raw` unchanged (`serialize.ts:48,62`), `write_entry` rewrites the same bytes, and `writeError` is cleared. The body is dropped and the UI says nothing. Under a naive "clear unpublished on success" rule, the retained text would be erased too.

## Concrete API

```ts
// table.svelte.ts
const unpublishedBodies = new SvelteMap<string, string>();
const scheduledBodies = new Set<string>();

// write(): refuse instead of inventing or no-op'ing; return whether it landed.
//   raw === null              -> failure `${fileName} was removed`
//   parseMarkdown(raw) errors -> failure `${fileName} has unreadable frontmatter`
// editBody/editField: return Result (or undefined) on unparseable input, not raw.
function write(fileName, edit: (raw: string) => string): Promise<boolean>

function setBody(fileName: string, body: string): void {
  unpublishedBodies.set(fileName, body);
  if (scheduledBodies.has(fileName)) return;     // coalesce: ≤1 in flight + ≤1 queued
  scheduledBodies.add(fileName);
  void serializeWrite(fileName, async () => {
    scheduledBodies.delete(fileName);
    const body = unpublishedBodies.get(fileName);
    if (body === undefined) return;
    if (await writeNow(fileName, (raw) => editBody(raw, body))
        && unpublishedBodies.get(fileName) === body)
      unpublishedBodies.delete(fileName);
  });
}
function bodyOf(row: Row): string { return unpublishedBodies.get(row.fileName) ?? row.body; }
get hasUnpublished(): boolean { return unpublishedBodies.size > 0; }
```

- **`TableView`:** replace `saveBody` with `setBody` and `bodyOf`.
- **`MarkdownBodyEditor`:** add `EditorView.updateListener.of(u => u.docChanged && onInput(u.state.doc.toString()))`. Seed from `bodyOf(row)` with `untrack` as it does now. Keep the Vim compartment and the `{@const fileName}` capture, which protects a retired control from writing to another row.
- **Errors:** `writeError` keeps its current meaning. The existing `TablePane` alert is the failure notice.

**What gets deleted:** `commitCurrentBody`, `submittedBody`, the blur `domEventHandlers`, the teardown commit, and the comment explaining that dedupe. Also gone are the silent `editBody`/`editField` no-ops, the empty-file fallback in `write`, and file recreation on removal. Nothing new is shared: no codec, no draft session, no patch API.

**What it costs:**
- **One full write cycle per in-flight window.** Each write does a native read, an atomic write, the watcher echo, and `onChange` → `mirror.syncTable` over the whole table (`vault.svelte.ts:83`). Coalescing bounds this to one in-flight write plus one queued, not one per keystroke.
- **Edits from other processes to the open body are overwritten** on the next coalesced write. That was already true on blur; it now happens much sooner.
- **One new piece of state:** the map, plus a `scheduledBodies` set.

## Counterexamples under this design

| Case | Result |
|---|---|
| Save fails, then the dialog closes | The text stays in `unpublishedBodies` and the alert stays up. Reopening seeds the unpublished text. The next edit republishes it. |
| Save echo of v1 arrives after v3 was typed | While v3 is unpublished, `bodyOf` returns v3. **Remaining gap:** after v3 is applied, a watcher batch that read v1 bytes earlier can land briefly (`watch.rs:73` reads at debounce time). Reopening in that window and typing would publish v1 plus the new edit. The current code has the same window. I'm not claiming it's fixed. |
| File removed while text is unpublished | The write is refused with "was removed", so no file is created. The text is kept but has no row to display it. If the file comes back (e.g. git checkout), reopening shows the unpublished text over the restored body. Nothing is published until the person types, so the overwrite is visible, not silent. **Product choice:** keep this, or drop the text on a `removed` delta with a notice. |
| Frontmatter becomes malformed from outside | The write is refused with a reason and the text is kept. Matter has no Source repair UI for unreadable files (no component handles `unreadable`). Once the file is fixed outside, the row returns and the dialog reopens with the unpublished text. |
| `matter.json` becomes unreadable | The view goes untyped and the dialog closes. Nothing is published, and the text is kept until the contract returns. |
| Vault closed or app quit with text unpublished | **Lost.** `hasUnpublished` lets you add a close guard cheaply; that's a separate decision. |
| Table switch | Safe: the table handle persists. |

## Not grounded / evidence needed
- I haven't checked whether Svelte or CodeMirror can dispatch a `docChanged` transaction during `destroy`, e.g. a Vim exit. If that could happen, the retired-control capture is what stops it writing to another row.
- Native acceptance is still blocked. The checks that matter on the Tauri target:
  - force a `write_entry` failure, close, reopen and confirm the text is there;
  - delete the file while typing and confirm no `---\n{}\n---` file appears;
  - break the frontmatter while typing and confirm the error shows and the text is kept;
  - type continuously and confirm `write_entry` calls ≤ keystroke batches and the final file matches.
- A browser test of the widget, plus a table unit test with mocked `invoke`, can cover coalescing, keeping text after failure, and both refusals. That isn't full native acceptance.
