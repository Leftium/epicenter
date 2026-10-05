# 0504. Row editors own complete input and one publication queue

- **Status:** Accepted
- **Date:** 2026-10-05
- **Amends:** [ADR-0483](0483-honeycrisp-shares-one-canonical-editor-per-open-row.md), replacing partial changes, schema-gated acquisition and saving, raw-session transfers, recreation, and automatic file adoption. One owner per open row and application close consent remain.
- **Amends:** [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md), replacing the retained table editor's surface. Ordinary table and file commands remain.

## Context

A second application draft requires its own timer, baseline, interpretation,
submitted value, failure handling, and synchronization with the row editor.
Automatic adoption of external file changes adds another source of input.
A read failure that hides the owner's input forces the application to keep a
copy precisely when that input matters most.

The chosen editing workflow accepts complete input immediately. The editor
shows it and saves it automatically. Each editor serializes its own writes.
Across independent editors, handles, and file APIs, whichever write lands last
wins. A person deliberately reloads to adopt their changes.

## Decision

### One owner holds complete input

`folder.tables.<name>.edit(stem, { signal? })` reads once and acquires an editor
fixed to the row address. Missing, unreadable, non-UTF-8, invalid-address, and
aborted acquisition yield no editor. Readable malformed or schema-invalid text
opens for raw repair. The signal governs acquisition only.

```ts
const { data: owner, error } = await notes.edit(stem, { signal });
if (error !== null) return showOpenError(error);
const editor = fromRowEditor(owner);

editor.set({ fields: { ...editor.row.fields, title }, body: editor.row.body });
editor.setText(source);
editor.retry();
await editor.flush();
await editor.reload();
```

Structured callers first narrow `editor.row.status === 'valid'`. They carry
all fields, including unknown metadata, into each complete replacement.
Omitted keys are intentionally deleted. Setters never merge from disk or a
previous row. `set` reads only `fields` and `body`, owns their canonical text
synchronously, and returns a representation Result. A refusal changes nothing.
Schema-invalid representable input is accepted and saved, then exposed as raw
repair input. `setText` retains text exactly, including malformed frontmatter.
Text UTF-8 cannot encode exactly is retained and reported rather than written
lossily. Structured formatting may remove frontmatter comments and quoting.

The immutable snapshot contains two independent facts:

```ts
type RowState<T> =
  | { status: 'valid'; text: string; fields: CompleteFields<T>; body: string }
  | { status: 'invalid'; text: string; error: RowError };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving'; error?: RowSaveError }
  | { status: 'failed'; error: RowSaveError };
```

These are illustrative aliases; current exports live in `packages/folder`.
The complete canonical parse supplies the valid row's fields and body. It
retains unknown metadata and validates declared fields. Storage failure never
hides accepted input. There is no unreadable variant after acquisition.

### One active write and the latest waiting document

Setters accept input before returning. One captured write runs at a time.
Only the latest complete document waiting behind it is written next. Intermediate
waiting documents may never reach disk. A receipt settles its captured write and
never replaces newer input. The editor holds one active write promise and one
optional waiting text. `flush()` follows successive writes rather than retaining
a separate promise for the sequence.

Structured input is formatted, then enters the same interpretation and save path
as arbitrary text. There is no formatter-produced flag or second admission path.

Every write replaces an existing file. Deletion before publication yields
`NotFound`; the editor never recreates a deleted row. Independent writers follow
last-publication-wins at whole-row scope. Another writer's intervening metadata
or body changes can therefore be replaced. Git recovers only committed versions.

After a write finishes, successfully or unsuccessfully, the latest waiting
document is attempted. Failures remain visible in `saving.error` while newer input
writes. Success clears the previous error. Without waiting input, a failure stops
saving and is reported. A later edit starts saving normally. There is no automatic retry loop.
`retry()` optionally saves the visible document again; it is a new attempt, not
confirmation of an earlier uncertain write. `flush()` waits through successive
writes and returns the final relevant outcome. It never starts a write.

Storage carries no cross-writer request number. Browser and native owners retain
their file locks, publication conditions, and permissions. Native protocol 7
removes the submission argument; incompatible page and host versions are refused.
A delayed or duplicate transport delivery can land after another write. The
last-landed-wins policy accepts that consequence and promises no at-most-once
delivery.

### Reload is the only read after acquisition

Subscriptions invalidate memory reads. They attach no storage watcher and perform
no reads. External file changes and save receipts do not trigger adoption.

`reload()` waits for active and waiting writes to settle, then reads the existing file.
Success deliberately discards held input and clears its save failure. Read
failure returns an error and preserves the entire snapshot. A setter or save
admission during reload prevents adoption with `InputChanged`. When reloads
overlap, the latest call decides and earlier calls settle with its result.
Applications fence input during deliberate reload and confirm discard when
held input would otherwise be lost. Discarding an `Unconfirmed` failure does
not confirm or cancel that earlier write. Idle describes the newly adopted local state.

### Svelte tracks the same owner

`fromRowEditor` at `@epicenter/folder/svelte` exposes tracked `row` and `save`
getters and the owner's own `set`, `setText`, `retry`, `flush`, and `reload`.
One `createSubscriber` connects these getters to memory invalidation. The
adapter copies no input, diagnostics, or publication state. Repeated adaptation
reuses the wrapper.

Function bindings read the current row and immediately call the owner. Callers
check view lifetime and mode because an outgoing control can still emit input.
Textarea newline projection and restoration preserve exact source text.
Unmounting removes subscriptions; it does not cancel admitted writes.

Applications retain owners through active or failed saves. Before changing a
path or closing storage, they fence input and wait for admitted work. A failure
leaves the current input visible. New input saves normally; an explicit retry or
reload remains available. Quit may
warn and offer quit anyway. Creation forms, conditional inference publication,
and arbitrary-file editing have their own contracts; they are not duplicate row
drafts. A field-local buffer remains justified when a control can hold input
that the complete document cannot represent.

## Consequences

Application whole-row drafts, delayed submission timers, submitted-text copies,
background adoption, read-readiness gates, and row/raw publisher transfers leave
this workflow. One owner replaces their synchronization protocols. List refresh
and ordinary file watching remain separate from editor input adoption.

Whole-row last-landed-wins can overwrite another writer's changes. A failed
attempt does not reserve the file against later input or other writers. Reload
is deliberate, and a reload failure keeps the current input accessible for copy
or repair. Immediate saves may produce more history versions; history policy
owns commit coalescing rather than introducing another input owner.

The remaining protection has a named purpose: exact encoding protects typed
text, complete parsing protects unknown fields, replace-existing prevents row
resurrection, path fences prevent writes to the old address, and explicit
uncertainty prevents false success claims.

## Verification

Controlled storage tests cover serial writes with latest waiting input, failure
with waiting input, failure followed by a later edit, explicit retry, flush
through consecutive writes and subscriber input, deletion, reload failure, concurrent
input, overlapping reloads, malformed repair, and complete metadata. Mounted
Svelte tests cover direct bindings, outgoing views, subscription lifetimes,
newline preservation, and accepted writes surviving unmount.

The [execution evidence](../../packages/folder/evidence/complete-row-editing.md)
distinguishes implementation checks from browser and native UI acceptance.
