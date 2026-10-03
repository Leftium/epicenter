# Canonical editor API (experiment)

Status: experimental evidence. `canonical-editor.ts` is not part of
`@epicenter/folder`, and the wave 4 demo does not use it. Run its tests from
the repository root:

```sh
bun test packages/folder/evidence/edit-handle/canonical-editor.test.ts
```

`canonical-editor.test-d.ts` holds the call-site type evidence; the folder
package's `tsc` checks it.

## Open, edit, save

```ts
const editors = createCanonicalEditors(folder, definition);

const { data, error } = await editors.tables.todos.edit(stem, { signal });
if (error !== null) {
	switch (error.name) {
		case 'Aborted':
			return; // the person navigated away; nothing is subscribed
		case 'NotFound':
			return showMissing(error.path);
		case 'UnsupportedSource':
		case 'InvalidSource':
			return showRepair(error.file); // exact text and SHA-256 for repair
		default:
			return showUnreadable(error);
	}
}

const editor = data;
const { get, subscribe, change, save, refresh, adopt, dispose } = editor;

// Keys are declared fields; values may not conform yet. `undefined` removes
// a field; unnamed fields, unknown metadata included, stay.
const { error: changeError } = change({ fields: { title: 'Plan B', priority: undefined } });
if (changeError !== null) return showChangeRefused(changeError); // Unrepresentable | Disposed

const { data: receipt, error: saveError } = await save();
if (saveError !== null) {
	// InvalidDocument and Saving wrote nothing. Unconfirmed may have landed:
	// `get().lastSave` keeps it as unknown.
	return showSaveFailed(saveError);
}
showSaved(receipt.sha256); // the submitted bytes, not a later read
```

`definition` supplies each table's declared field order. A `Folder` does
not expose its definition, so the caller passes the one it opened with.
Every method closes over the editor and never reads `this`, so the
destructured functions above behave exactly like `editor.save()`.

## Proposed production ownership

The wrapper exists to exercise this API without editing production folder code.
The long-term call site should put the method on the table that already owns
its row address, schema, and field order:

```ts
// Proposed API, not a current @epicenter/folder export.
const { data, error } = await folder.tables.todos.edit('plan', { signal });
if (error !== null) return showOpenError(error);
const { get, subscribe, change, save, refresh, adopt, dispose } = data;
```

`edit` opens a retained draft for that row. Its result's `data` is the editor;
`get().document` is the local content. No second `open()` step or nested handle
is needed. A form owns the editor, and its controls share it. Save timing is
chosen by the form or by an immediate control. A checkbox that owns an editor
may call `change({ fields: { done } })` and then `save()` in the same handler;
that save publishes the complete document, including any other local edits.
A field-only write is a separate table operation, not a full-document save.

```text
folder.tables.todos
`-- edit('plan') -> Result
    |-- error: opening refused, with repair evidence when available
    `-- data: editor (fixed todos/plan.md)
        |-- local document + comparison baseline + file observation
        |-- views: subscribe/unsubscribe independently
        |-- change -> local input
        |-- save -> complete canonical file replacement
        |-- refresh -> reread the fixed path
        |-- adopt -> take reviewed current file content
        `-- dispose -> stop watching; finish admitted save; release listeners
```

A direct file editor can own the same lifetime for raw text, but this prototype
only implements table rows. It does not invent a structured schema for arbitrary
files or treat audio bytes as form fields.

## Lifetime

```ts
let opening: AbortController | undefined;
let current: CanonicalEditor<Todo> | undefined;

async function show(stem: string) {
	opening?.abort();
	const controller = new AbortController();
	opening = controller;
	void current?.dispose(); // an admitted save still lands; navigation does not wait
	current = undefined;

	const { data: editor, error } = await editors.tables.todos.edit(stem, {
		signal: controller.signal,
	});
	if (opening !== controller) {
		// A newer show() started. This open may still have returned an editor
		// if it finished just before the abort; it belongs to no view.
		if (error === null) void editor.dispose();
		return;
	}
	if (error !== null) return presentOpenError(error);
	current = editor;

	// Every view of this row shares `editor`; each subscribes on its own.
	const stop = editor.subscribe((state) => render(state));
	// `stop()` ends only this view. `editor.dispose()` ends watching for all.
}
```

- `edit` subscribes to `onFilesChanged` before its single read. A hint
  during that read becomes a reread once the editor exists.
- `signal` governs opening only. An abort before or during opening returns
  `Aborted` at once and unsubscribes. Once `edit` returns the editor, the
  caller owns it and ends it with `dispose`, as the stale branch above does.
- `subscribe` gives the listener the current frozen state, then each
  notification. Reentrant changes may coalesce intermediate states: this is
  a current-state subscription, not an event log. Called outside a notification, the first call happens before
  `subscribe` returns; called inside one, it happens after the running
  listener returns. Delivery is never reentrant: a listener that changes
  the document is called again after it returns, and no subscription gets
  the same state twice. Each call is its own subscription. What a listener
  throws is logged and never reaches `change`, `save`, or another listener.
- A save is admitted before any listener hears `saving`. A listener that
  disposes then waits for that save, and one that starts the next save
  when the first settles keeps its own admission.
- `dispose` stops watching and refuses new input, reads, saves, and
  adoptions. An admitted save still settles into `lastSave`, and the
  returned promise settles after it. It then releases all listeners. A
  subscription made after terminal disposal receives the current state once
  and is not retained. Repeated calls, including from a
  listener during disposal, return the same promise.

There is no registry, autosave, or focus protocol. The app decides which
views share an editor and when to call `save`.

## Shape

```text
createCanonicalEditors(folder, definition)
`-- tables.<name>.edit(stem, { signal }) -> Promise<Result<editor, OpenError>>
      OpenError: InvalidPath | NotFound | read errors | InvalidUtf8
               | Aborted | UnsupportedSource{file,refusal} | InvalidSource{file,reading}

editor
|-- get() -> state
|-- subscribe(listener) -> unsubscribe        listener(state) now, then current-state notifications
|-- change({ fields?: { [declared key]?: CanonicalValue | undefined }, body? })
|     -> Result<undefined, Unrepresentable | Disposed>
|-- save() -> Promise<Result<Revision, InvalidDocument | Saving | Disposed | FileError | ApplyError>>
|-- refresh() -> Promise<void>                one coalesced read after this call
|-- adopt({ path, canonical }) -> Result<undefined, Stale{latest} | Saving | Disposed>
`-- dispose() -> Promise<void>

state
|-- baseline: Revision        what isDirty compares against
|-- document, source          local fields and body; source is the canonical text save writes
|-- reading                   how source reads: issues make save refuse
|-- isDirty                   canonical text differs from baseline.canonical
|-- observation               latest read: present | missing | unreadable | unsupported | invalid
|-- saving: SaveAttempt       captured document while a save is admitted
|-- lastSave                  saved{receipt} | unconfirmed{attempt} | failed{attempt}
`-- isDisposed

Revision    = { path, sha256, source (exact text), document, canonical (text) }
SaveAttempt = { path, document, source (canonical text sent) }    no hash: not a capture
```

## Rules

- Open gate. `edit` opens only a file that has a canonical form and whose
  declared fields conform. A refusal carries the exact text when there is
  one, so a repair screen can show it and `files.overwrite` it.
- Local input. `change` may make the document schema invalid; `reading`
  shows the issues and `save` refuses with `InvalidDocument`, writing
  nothing. A value with no canonical form, such as `NaN`, is refused by
  `change` and the document is unchanged. `undefined` removes a field;
  unnamed fields, unknown keys included, stay.
- Typed keys. `change` names declared fields only, so a misspelling or an
  unknown metadata key does not compile. Values are any canonical value,
  because input must hold what the schema rejects. `document.fields` is not
  narrowed to the row type; `reading.fields` is the validated view. Editing
  unknown metadata is a raw repair through `files.overwrite`. The runtime does
  not check keys, so untyped callers can still name any key.
- Format. A save writes `files.overwrite(path, canonical)`: declared keys in
  declared order, other keys in code unit order, every value in JSON flow
  style. Comments and YAML spelling are not kept. Opening a differently
  formatted file is clean, so opening alone writes nothing.
- Dirty and change. Dirty is semantic: the local canonical text differs
  from the baseline's. External change is exact: a read's SHA-256 differs
  from the baseline's.
- Reads. A clean editor follows a valid read. A read never resets dirty
  input. A missing, unreadable, unsupported, or invalid read updates
  `observation` and keeps the document. When a read already holds the local
  content, the editor becomes clean.
- Saves. One save is admitted at a time and captures the document when
  `save()` is called. Input during it stays local and dirty against the
  receipt. The receipt is the attempt plus the SHA-256 that `overwrite`
  returned for the bytes it was given; the editor does not hash them again.
  A clean document is saved too: `save()` always writes the whole document.
  Nothing retries or queues. A port that throws is a bug, not an outcome:
  the editor releases the save, records nothing in `lastSave`, and the
  throw reaches `save()` and `dispose()`. During a save, reads update `observation` but adopt nothing;
  a read that started before the save settled is dropped and read again.
- Unknown outcome. `Unconfirmed` stays in `lastSave` forever. A later read
  whose canonical content is the local document's makes `isDirty` false,
  because the file holds that content. It does not upgrade `lastSave`: the
  read cannot say which writer put it there. The comparison is by content;
  the attempt has no hash to compare.
- Review. `adopt(reviewed)` takes the file's current content in place of
  local input. It reads only `reviewed.path` and `reviewed.canonical`, and
  succeeds while the latest valid read has that canonical content, even if
  another tool has since changed its comments or quoting. The editor then
  follows its own latest revision, so a supplied document, source, or hash
  never enters it. Different content returns `Stale` with the newer
  observation. `adopt` chooses the reviewed current content; it never
  restores a version the file no longer holds. "Keep mine" is `save()`.

## Tradeoffs left open

- `adopt` refuses reviewed content the file no longer holds. The other
  choice, putting the reviewed content back as the local document, would
  leave it dirty against the newer file and a later save would write the
  old content over the newer one: a restore, which `adopt` is not. A dirty
  editor whose file is missing, unsupported, or invalid has no adopt
  target: it can save, which replaces the file, or be disposed.
- `adopt` is refused while a save is admitted. Nothing yet needs it there;
  allowing it would need rules for the save's receipt landing afterward.
- `save()` writes a clean document too. An autosave or quit path that only
  wants unsaved work should check `isDirty` itself; that is app policy.
- `observation` is the latest completed read, so right after a save
  receipt it can briefly show the earlier file until the reread lands.
  A review UI that compares its SHA-256 with the baseline's can show that
  window as a difference that is not another writer.
- The editor does not follow a newer read when typing returns the document
  to the baseline; it follows on the next read.
- `change` formats and parses the whole document on each call. Fine for row
  frontmatter; a large body would want a cheaper body path.
- Saves are unconditional, and nothing protects against a race. A write by
  another writer that lands before a save, read or not, is overwritten.
  `observation` is advisory: it reports what the last read found, and
  reviewing it does not make a later save conditional on it.
- Schema-invalid external files are not followed. A clean editor keeps its
  last valid document and shows `observation.kind === 'invalid'`.
