# 0504. Row editors own complete input and one publication queue

- **Status:** Proposed
- **Date:** 2026-10-05
- **Amends:** [ADR-0483](0483-honeycrisp-shares-one-canonical-editor-per-open-row.md), replacing partial changes, schema-gated acquisition and saving, raw-session transfers, overwrite/recreation, and the editor's review/adoption/disposal protocol. One owner per open row and application close consent remain.
- **Amends:** [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md), replacing only the retained table editor's surface. Folder composition and ordinary table/file commands remain.
- **Unbuilt:** The replacement core editor, tracked Svelte adapter, application migrations, and asynchronous acceptance evidence.

## Context

The current `table.edit(stem)` exposes `get`, state-valued `subscribe`, `change`,
`save`, `refresh`, `adopt`, and `dispose`. It opens only canonical conforming
rows, saves through `overwrite`, and refuses schema-invalid input. Applications
mirror its state and coordinate separate raw editing owners. This makes switching
to repair depend on settling the structured editor first.

The desired unit of editing is a complete row: every frontmatter field,
including unknown metadata, and the Markdown body. A developer may submit each
edit immediately or keep a separate form draft and submit complete replacements
periodically. The ordinary live interface disappears when storage cannot read
the backing row. Readable input that cannot support a structured form remains
editable as raw text through the same owner.

## Decision

**One framework-independent row editor owns accepted complete input and one
publication queue for structured and raw replacement.**

`folder.tables.<name>.edit(stem, { signal? })` acquires an editor fixed to that
address. Missing files, address errors, read failures, and cancellation refuse
acquisition. Malformed or schema-invalid readable text yields an editor for
repair. The signal governs acquisition, not the returned owner's lifetime.

The following is the target surface, not the current implementation:

```ts
rowEditor.get();             // synchronous held snapshot
rowEditor.subscribe(wake);   // invalidation only; returns unsubscribe
rowEditor.set(nextRow);      // synchronous representation Result; queues save
rowEditor.setText(text);     // accepts raw input into the same queue
rowEditor.refresh();         // Promise<void>; observe storage again
```

`set` receives the complete unvalidated `{ fields, body }` value. It owns the
value synchronously and formats it before returning. Representation refusal
leaves input and publication unchanged. Schema validation determines structured
UI eligibility, not permission to save. Omitted keys are deleted; preparation
never merges keys from disk or a previous row into the supplied replacement.
The setter reads only `fields` and `body`; public variant metadata such as
`status` and `text` is not an input to structured formatting.

Canonical formatting is deterministic for the same complete value and declared
key order. It normalizes frontmatter presentation and retains the supplied body
exactly. Raw replacement permits malformed frontmatter and uses the text
publication boundary. Raw input that cannot round-trip through UTF-8 remains held
with a publication representation failure, rather than a lossy write. A later
representable setter provides repair. Such raw input is publicly invalid while
readable. Its publication failure surfaces when that capture reaches the queue's
turn, not while an older capture is still active. No save silently reconstructs a row from partial validated
fields. The valid row value comes from the complete canonical parse; validation
checks declared fields without dropping unknown metadata.

**Readability and validity form one public row gate; publication remains
independent.**

The target snapshot contains `row` and `save`. Text belongs to the readable row
variants; there is no standalone text getter or structured-value wrapper.

```ts
type RowState<T> =
  | { status: 'valid'; text: string; fields: Row<T>['fields']; body: string }
  | { status: 'invalid'; text: string; error: RowError }
  | { status: 'unreadable'; error: ReadError };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'failed'; error: SaveError };
```

These aliases illustrate the states; error types reuse the underlying codec,
conformance, and storage contracts. `Row<T>` retains all metadata and adds typed
declared fields only after complete validation. Valid rows expose `text`,
complete `fields`, and `body` directly. Those values describe the same immutable
input snapshot: parsing that text supplies those fields and body. The setter
accepts an unvalidated `{ fields, body }` row, not only a validated public variant.

**Accepted input becomes the row snapshot synchronously, before publication.**

On acquisition, accepted input is the observed file text. A successful `set`
owns and canonically formats the complete input; `setText` owns the supplied raw
text. Before the setter returns, that text becomes current accepted input and
the readable row is rebuilt wholly from it. Its text never comes from disk while
its fields come from a queued edit. Representation refusal from `set` changes
neither the accepted snapshot nor publication state.

While backing storage is unreadable, a setter can still accept application input,
but the public row remains `{ status: 'unreadable', error }`. The owner retains
the input privately for publication and later readable projection. It exposes
no text, fields, body, or last-valid value through that variant. Applications
needing access to a continuing draft during the outage retain it themselves.

A successful read installs its entire text snapshot only when adoption is
eligible. Otherwise it updates backing readability without replacing accepted
input. A save receipt settles the captured attempt; it never rolls the public
row back to that attempt when newer input exists.

A later read failure, including absence, makes `row` unreadable and hides both
live editing views. A readable backing row permits interpretation of current
accepted input: valid input supports the structured form; invalid input supports
raw repair. Readability and accepted input remain distinct internal facts.
An unreadable gate does not discard accepted input, cancel publication, or imply
that saving failed. A successful save receipt cannot clear that gate by itself.

**Setters accept input immediately; one active write and one latest pending
capture publish existing rows in order.**

Pending input may be superseded before submission. An active write is never
cancelled by newer input. The setters acknowledge local acceptance, not file
publication. They mark the state saving synchronously when work is admitted;
there is no observable idle gap when pending input follows an active write.

Each publication uses `table.replace(stem, text, {})`. Presence is checked at
the storage publisher: deleting the row before publication produces absence,
never recreation. Independent writers follow last-publication-wins. Metadata
added elsewhere after local adoption may be replaced by the complete supplied
row. This is an explicit replacement contract, not a preservation guarantee
for concurrent writers.

A failed or uncertain active attempt pauses the chain, including newer pending
input, and pauses automatic input adoption. Latest accepted input remains held.
The failed status describes a stopped publication chain; an `Unconfirmed` error
must be presented as uncertainty, never a definite unsuccessful write.

An explicit setter call starts a new attempt, even for identical row or text.
It can replace the current failure display as the new attempt begins. It never
retroactively confirms an old uncertain operation. A read finding matching
bytes is an observation, not an acknowledgement. Automatic buffered submission
must not repeatedly call setters through a paused failure as an implicit retry.
While readable, an explicit retry submits `{ fields: row.fields, body: row.body }`
for valid input or `setText(row.text)` for invalid input.

**Observation cannot replace newer or unpublished input.**

Acquisition briefly observes before its initial read and releases that watcher
before returning. The first subscriber attaches observation before rereading;
the last unsubscribe stops observation maintenance. Subscriptions do not deliver
an initial value: callers subscribe, then read. Accepted publication continues
without subscribers. Dormant `get()` reads held memory, not guaranteed fresh disk.

Refresh uses the same guarded read path, works without subscribers, and creates
no permanent watcher. It completes after an observation requested by that call;
a call during an older read requires a subsequent pass. Expected read failures
appear in `row`, rather than a second Result returned from refresh.

Input changes block read adoption but do not suppress a current read's
readability result. Publication settlement invalidates older reads, which must
be discarded or repeated. Adoption is allowed only with no active, pending, or
failed accepted publication and no input change since the read began.
A current result belongs to the serialized read path and has no publication
settlement since its read began. A failure installed before settlement stays
unreadable until a successful observation; a result finishing after an intervening
settlement is not installed. Each settlement schedules a guarded reread while
the owner has subscribers. Dormant owners perform no automatic settlement read;
refresh or a new subscriber requests observation again.

For example, A fails while B is pending, then refresh reads disk C. Readability
recovers, but B and the publication failure remain. The form or raw view derives
from B. Refresh neither publishes B nor replaces it with C.

**Svelte tracks the owner through getters; applications own continuing form
drafts and close policy.**

`fromRowEditor` at the proposed `@epicenter/folder/svelte` entry returns a
`ReactiveRowEditor`. Components call it `editor`. It exposes tracked `row`
and `save` getters and the same `set`, `setText`, and `refresh` commands.
One `createSubscriber` serves its getters. Repeated adaptation reuses the
wrapper; it stores no second row, diagnostics, or publication state.

Raw function bindings read the latest readable `editor.row.text` and call
`editor.setText`; getters narrow the row status because teardown can follow
an unreadable transition. Structured handlers capture the latest row inside the
event and submit its complete fields and body. There is no standalone `.text`,
`.value` wrapper, `.current`, `.content`, `.readError`, separate raw owner, or
public field-patch command in this editing workflow.

An application that keeps an unsubmitted `$state` draft owns its validation,
repair, submission timing, and reset policy. It retains that draft above any
conditional that can remove the form. The core cannot validate input it has
not received; its older text is not repair text for a newer application draft.

The application retains the core owner through pending or failed publication.
Before folder closure or path-changing work, it fences new input, submits any
chosen final draft, subscribes before checking save state, and waits for admitted
work. Failed input needs retention or deliberate discard. There is no mandatory
public `dispose`, `settled`, `retry`, `adopt`, draft registry, or universal flush.
To discard failed accepted input, the application deliberately releases the
settled owner and reacquires the row. Reacquisition is a new owner, not adoption
inside the failed one; it can fail if the row is still missing or unreadable.

## Consequences

Raw/structured owner transfers, mirrored Svelte state, reviewed adoption, partial
change merging, concurrent-save refusals, and schema-invalid save refusals leave
the row editing workflow. Arbitrary-file editors and ordinary source-preserving
table commands remain separate capabilities. Native close consent and explicit
rename/delete conditions remain application responsibilities.

A transient read failure can unmount the live form. Draft continuity beyond
accepted input is an application choice. Privately retained input is not publicly
readable while the backing row is unreadable. An application needing a copy or
export during that outage retains its own draft before submitting it. After
external deletion, hidden accepted input is accessible again only from that
application draft or when the row reappears and refresh restores readability.
If failed B is retained and the row is explicitly recreated as C, refresh exposes
B and preserves its failure; it does not adopt C. The core never recreates the row.
The queue coalesces pending input and
does not promise every intermediate keystroke reaches storage. Frontmatter
comments may disappear on a structured save. Git only retains versions actually
committed; it is not a guaranteed undo mechanism for replacement.

Runtime evidence must cover publication ordering, no resurrection, refresh with
failed input, overlapping reads, immediate close, and real Svelte bindings and
subscription lifetimes. Existing codec tests and compilation of binding examples
do not establish those lifecycle guarantees.

## Considered alternatives

- Keep read failure independent from row eligibility: supports continuing live
  forms, contrary to the chosen interface. Applications can retain their own draft.
- Copy core values into reactive state: creates another owner and synchronizes
  diagnostics and publication state unnecessarily.
- Give raw repair another publisher: restores transfers and competing queues.
- Merge metadata during complete replacement: makes omission ambiguous and turns
  replacement into a patch.
- Hide all failures in one editor status: cannot express valid input with failed
  publication, or unreadable storage while publication continues.
- Remove refresh: leaves retained error views dependent on a change hint that
  transient failures and external Bun writers may never produce.

## Execution evidence

The [implementation plan](../../specs/20261005T015758-complete-row-editing.md)
records backward milestones, caller migration, review findings, and acceptance
checks. This record states the intended contract; current source and package
documentation still describe the previous implementation.
