# Complete-row editing

**Date:** 2026-10-05
**Status:** Draft
**Owner:** Codex coordinates decisions, verification, and integration

## One sentence

Replace the retained row editor and row/raw handoff protocols with one complete-input publisher and a Svelte adapter whose tracked getters expose row eligibility and publication state.

The durable direction is recorded in [the complete-row editing decision](../docs/adr/0504-row-editors-own-complete-input-and-one-publication-queue.md).
This plan covers the replacement; it does not claim that the target API exists.
This pass writes decisions and execution scaffolding, not production code.

Read first: current state, target shape, backward milestones, acceptance checks.
Read the review adjudication before changing ownership or publication semantics.

Completion means all current row-editor callers use the replacement, asynchronous
and Svelte acceptance cases pass, obsolete row-specific protocols are removed,
and package documentation reflects the implemented surface. Native close and
real browser interaction require their own evidence. Then retire this spec;
keep durable decisions in the ADR.

## Current state

`packages/folder/src/editor.ts` opens only canonical conforming rows, merges
partial `change` input, refuses invalid saves, publishes through `overwrite`, and
exposes explicit save, refresh, adoption, and disposal protocols. Overwrite can
recreate a deleted row. Its subscribers receive state values immediately.

`packages/folder/src/table.ts` already supplies existing-row
`replace(stem, text, {})` without a preparation read. The canonical codec
already owns complete fields/body conversion, deterministic formatting, unknown
metadata, schema-independent representation checks, and exact supplied body.
`readRowText` produces partial conformance output; it omits unknown and invalid
fields and cannot supply a complete replacement value.

Todos and Honeycrisp mirror editor state and coordinate autosave, holds, source
handoff, and disposal. Capture, Whispering, and Vocab also acquire retained row
editors. Arbitrary-file sessions are separate consumers and remain supported.

The checkout contains extensive unrelated uncommitted work. Establish a fresh
implementation baseline and change only this lane. This planning pass changes
only decision records and planning/current-behavior pointers; do not stage unrelated files.

## Target shape

The following signatures are target sketches. Resolve imports and error aliases
against current source in the first implementation wave.

```ts
type Row<TFields = Record<string, CanonicalValue>> = {
  readonly fields: DeepReadonly<TFields> & Readonly<Record<string, CanonicalValue>>;
  readonly body: string;
};

type RowState<TFields> =
  | {
      readonly status: 'valid';
      readonly text: string;
      readonly fields: Row<TFields>['fields'];
      readonly body: string;
    }
  | { readonly status: 'invalid'; readonly text: string; readonly error: RowError }
  | { readonly status: 'unreadable'; readonly error: ReadError };

type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'failed'; readonly error: SaveError };

type RowEditorState<TFields> = {
  readonly row: RowState<TFields>;
  readonly save: SaveState;
};

type RowEditor<TFields> = {
  get(): RowEditorState<TFields>;
  subscribe(invalidate: () => void): () => void;
  set(next: Row): Result<void, CanonicalRefusal>;
  setText(text: string): void;
  refresh(): Promise<void>;
};
```

`Row` is complete but unvalidated. `Row<TFields>` describes the valid output,
including all unknown metadata. Do not constrain `set` to valid output types.
Valid public rows expose text, fields, and body directly; invalid public rows
expose text and error. Unreadable exposes only error. There is no standalone
`editor.text`, last-valid value, or `.value` wrapper.
Reuse codec/conformance/storage diagnostics rather than inventing a parallel
error framework. Missing-after-acquisition becomes an unreadable row with a
distinguishable `NotFound` error. Initial missing/I/O/cancel/address errors yield
no editor; initial invalid readable text yields a repairable editor.

Existing `CanonicalDocument` already represents the same unvalidated shape.
Resolve that type into one complete-row vocabulary during the public cutover;
do not publish competing `RowContent`, `RowDocument`, and `Row` aliases. Preserve
codec behavior and assess codec-name changes separately from queue correctness.

```text
Application lifetime, above conditional editing views
|-- retained native RowEditor
|     accepted input + backing availability + publication queue
|     |-- whole-row setter: owned input -> canonical text
|     `-- raw setter: owned text
|                `-- existing-row replace publisher
|-- optional application form draft and submission timer
`-- fromRowEditor(native owner)
      tracked getters, same commands, no copied values
      |-- valid row: structured form, or application-selected raw view
      |-- invalid row: raw repair of accepted input
      `-- unreadable row: error view, editing interfaces hidden
```

### Observable contract

1. Getters read held memory and perform no storage I/O. The native owner may
   retain an immutable derived snapshot; the Svelte adapter may not cache values.
2. `set` synchronously owns all supplied values, validates representation,
   formats them, and admits the complete text. Caller mutation after return
   cannot alter held values or queued bytes. Omission deletes; no unknown-key merge.
   With readable backing storage, the complete accepted snapshot becomes public
   synchronously before return, rather than waiting for its save or a disk reread.
   The setter reads only fields and body; status and text carried by a public
   valid variant are ignored, not trusted as structured input.
3. Schema-invalid representable input is accepted and saved. Complete validation
   determines whether the structured form exists; it does not block publication.
4. Raw repair edits latest accepted text, not an older disk capture. Malformed
   frontmatter is allowed. A raw JavaScript string that cannot round-trip through
   UTF-8 remains held and stops publication with a representation diagnostic;
   do not publish a lossy encoding. This protects supplied input that the current
   encoder would normalize. A later representable setter is the repair path.
   Such text produces an invalid public row while readable. If A is active and
   unencodable B is pending, saving remains visible for A; B's representation
   failure surfaces only on B's queue turn. An earlier failure of A pauses B first.
5. One write is active and at most one latest capture is pending. Coalesced
   pending generations were accepted but never submitted. No setter promises
   publication of its individual generation. Active writes are not cancelled.
6. `saving` covers queued and active work from synchronous admission through
   final settlement. There is no observable idle gap between consecutive writes.
7. Failure or uncertainty of A pauses the chain even if B was accepted later.
   Retain latest B; do not report that B was attempted. Unexpected publication
   exceptions must produce a settled failed/uncertain state, never leave saving stuck.
8. Same-value `set` and same-text `setText` are explicit new attempts. Neither
   later success nor observed matching bytes retroactively confirms an old
   `Unconfirmed` outcome. UI copy distinguishes uncertainty from definite failure.
9. Every write uses existing-row replacement. The presence condition runs at
   publication, not in a preparatory read. Independent writers are last-publication-wins.
10. Read failure changes eligibility immediately when its observation is current,
    even if local input changed during that read. Hide both live editors; retain
    accepted input privately and continue admitted publication. The unreadable
    public row has no text, fields, body, or last-valid value. Receipts do not clear unreadability.
11. Input-generation guards block adoption. Publication-settlement guards reject
    or repeat older observations. Keep these guards distinct; dropping all reads
    overlapping typing would incorrectly hide availability failures.
    A current result belongs to the serialized read path and has no settlement
    since it began. A failure applied before settlement keeps the gate closed;
    a result completing after an intervening settlement is not installed.
12. Adopt external input only when idle with no pending or failed accepted
    publication and no input change since the observation began. Installing a
    read never calls a setter or echoes a save.
13. Refresh restoring readability derives eligibility from current held input.
    A failed A, pending B, and disk C remain distinct. Refresh does not replace
    B with C, clear A's failure, or initiate B's save.
14. Acquisition watches before reading and releases the temporary watcher before
    returning. First subscription watches before rereading; last unsubscribe
    stops observation only. Listener exceptions are isolated and delivery is
    non-reentrant. Subscribe has no initial delivery.
15. Refresh uses the same serialized/coalescing read path. Each call waits for
    an observation started for its request; a request during an older read
    requires a subsequent pass. Zero-subscriber refresh is a one-shot read.
16. Dormant owners need not continuously follow external changes. `get` remains
    a held-input read. Watching ends without public disposal; saving does not.
    While subscribed, each publication settlement schedules a guarded reread.
    With no subscribers, settlement performs no automatic I/O; refresh or the
    next first subscriber requests an observation.

### Which input becomes the public snapshot

The owner privately distinguishes current accepted input, the active publication
capture, the latest pending capture, and backing readability. The public row is
a projection of current accepted input gated by backing readability. It is not
an assembly of the newest available pieces from these different captures.

| Event | Public row snapshot |
| --- | --- |
| Successful acquisition | Complete observed text, interpreted as valid or invalid |
| Accepted structured setter while readable | Canonically formatted accepted text and its complete parsed fields/body, or invalid text/error, before setter return |
| Accepted raw setter while readable | Exact accepted text and its complete interpretation, before setter return |
| Structured representation refusal | Previous row and save state unchanged |
| A active; B accepted and queued | B is public immediately; A remains only the active publication capture |
| A's receipt arrives with B pending | B remains public; the receipt acknowledges A only |
| Current backing read fails | Unreadable/error only; accepted input remains private |
| B accepted while unreadable | Still unreadable/error; B replaces private current input and enters the queue |
| Readability recovers with pending or failed B | Public row is derived entirely from B; observed disk C is not installed |
| Eligible idle observation of C | Replace the complete accepted snapshot with C, without setters or publication |

For `valid`, text, fields, and body must all derive from one owned text capture.
For structured input, parse its formatted text to establish the exact public
values. For raw input, parse the accepted text without normalizing its spelling.
Do not take text from the last disk observation and fields from pending input,
or expose the older active attempt after a newer setter returns.

Automatic adoption requires no active, pending, or failed accepted publication,
no input changes since the read began, and a read not invalidated by publication
settlement. Successful refresh may restore readability without adopting its
contents. This rule preserves pending/failed input while keeping the public
variants faithful to one snapshot.

### Svelte caller

The proposed `@epicenter/folder/svelte` subpath exports `fromRowEditor` and
`ReactiveRowEditor`. Svelte stays an optional peer; importing core or a platform
entry must not require it. The adapter exposes only tracked `row` and
`save` getters plus the native `set`, `setText`, and `refresh` commands. Use one
`createSubscriber` and reuse adapters by native-owner identity.

```svelte
<script lang="ts">
  import { fromRowEditor } from '@epicenter/folder/svelte';

  let { rowEditor } = $props();
  const editor = $derived(fromRowEditor(rowEditor));
  let rawMode = $state(false);

  function title() {
    const row = editor.row;
    return row.status === 'valid' ? row.fields.title : '';
  }

  function text() {
    const row = editor.row;
    return row.status === 'unreadable' ? '' : row.text;
  }

  function setText(next: string) {
    rawMode = true;
    editor.setText(next);
  }

  function setTitle(title: string) {
    const row = editor.row;
    if (row.status !== 'valid') return;
    const result = editor.set({
      fields: { ...row.fields, title },
      body: row.body,
    });
    // Present result.error through the application's existing error UI.
  }
</script>

{#if editor.save.status === 'failed'}
  <SaveFailure error={editor.save.error} />
{/if}

{#if editor.row.status === 'unreadable'}
  <ReadFailure error={editor.row.error} />
  <button onclick={() => void editor.refresh()}>Check again</button>
{:else if editor.row.status === 'invalid' || rawMode}
  {#if editor.row.status === 'invalid'}
    <RowFailure error={editor.row.error} />
  {:else}
    <button onclick={() => rawMode = false}>Edit fields</button>
  {/if}
  <textarea
    aria-label="Markdown source"
    bind:value={text, setText}
  ></textarea>
{:else}
  <input aria-label="Title" bind:value={title, setTitle} />
{/if}
```

The error components are illustrative. The guarded getters handle binding
teardown; their empty return during an unreadable transition must never become
accepted input. Verify this in the real binding acceptance cases, including any
out-transition; compilation does not establish it. The conditional hides both editing views. Do not turn that
fallback into a last-valid editor or a public standalone text accessor.
Real consumers preserve their body newline convention when changing textarea
body text. A title-only replacement keeps the existing body unchanged.

Reusable raw components expose an intentional bindable value:

```svelte
<!-- RawEditor.svelte -->
<script lang="ts">
  let { value = $bindable() }: { value: string } = $props();
</script>
<textarea aria-label="Markdown source" bind:value={value}></textarea>
```

```svelte
{#if editor.row.status !== 'unreadable'}
  <RawEditor bind:value={text, setText} />
{/if}
```

Function bindings require Svelte 5.9.0 or later. The current root catalog uses
`^5.56.3`. See [function bindings](https://svelte.dev/docs/svelte/bind#Function-bindings)
and [createSubscriber](https://svelte.dev/docs/svelte/svelte-reactivity#createSubscriber).

The example keeps raw mode selected after a raw edit becomes valid, until the
person chooses Edit fields. That is view preference, not another owner or save
policy. Both editing views disappear
when unreadable. Destructuring getter values is a snapshot, not a reactive read.

### Optional application drafts and shutdown

A draft kept in `$state` must live above the row gate. Initialize it once for
the application editing session; do not reseed it through `$effect` on every
external observation or receipt. Its validity and raw repair belong to that
draft, not to the core's older accepted text. A timer submits only changed drafts
and pauses on core save failure; automatic repeated setters would implicitly retry.
Private accepted input remains retained by the core during unreadability, but
the public union intentionally exposes none of it. An application needing to
display, copy, or export draft input during that outage retains its own draft
before submission. Do not add a standalone text getter to recover the old interface.
For an explicit retry while readable, submit `{ fields: row.fields, body: row.body }`
if valid, or `setText(row.text)` if invalid. Deliberate discard releases the
settled owner and reacquires a new one after application consent; it is not
refresh-based adoption through a failed owner. If the file was deleted,
reacquisition still fails until the path is restored. Reappearance followed by
refresh can expose privately retained B while preserving its failed save.

Applications fence input before rename, delete, Git operations needing settlement,
or folder close. A small imperative await helper subscribes before checking
`get().save.status`, resolving when it is no longer saving. No new public settled
method or mirrored Svelte state is necessary. A failed result needs retention,
repair, or deliberate discard before forgetting input. Never treat failed as idle.
Unsubmitted drafts need their own decision before closure.

The helper observes the whole admitted chain, not a setter generation. Ordinary
navigation can retain an owner; conditional form teardown must not terminate it.
After confirmed rename, acquire the destination owner and swap retained references.
Do not reopen through an uncertain move or silently recreate a missing file.
Preserve existing per-file rename/delete conditions and native close consent.

## Backward milestones

The destination determines the work. These are listed from final evidence back
to the foundations; execute the dependencies in the forward order below.

| Completed destination | Prerequisite |
| --- | --- |
| Every application and evidence caller uses the target; old row protocols removed | Proven migrations and accurate package documentation |
| Native close, path changes, raw repair, and continuing app drafts work | Application retention and submission policies use one core owner |
| Svelte forms gate on row status and use function bindings | Proven tracked getter adapter over stable core snapshots |
| Availability and publication races preserve accepted input | Guarded observation and one shared latest-pending queue |
| Complete replacements never silently drop metadata or recreate deleted rows | Complete codecs, broad setter typing, existing-row publication |
| Implementers can work without reopening the model | ADR, signatures, caller inventory, and acceptance cases |

## Forward execution

### 1. Establish the acceptance baseline

- [ ] Capture the then-current source and unrelated working changes before editing.
- [ ] Inventory every production/evidence `table.edit` acquisition, wrapper,
  public export, and old method caller. Read the complete operations below,
  not just the acquisition line.
- [ ] Map error aliases to existing representation, conformance, and file errors.
  Type-check complete unvalidated setter input and valid unknown-key output.
- [ ] Add controlled async regression cases for the acceptance matrix. Preserve
  meaningful existing publication and information-protection tests.

### 2. Replace the native row owner

- [ ] Keep codec behavior; derive valid values from the complete parse.
- [ ] Replace partial changes and explicit save with owned complete setters,
  one active/latest-pending queue, synchronous saving state, and sticky failure.
- [ ] Publish through existing-row replace and preserve actual backend outcomes.
- [ ] Implement the public row union from internal accepted-input/readability facts.
  Atomically derive all readable fields and text from one accepted capture.
- [ ] Implement guarded acquisition, lazy observation, invalidation subscribers,
  and explicit refresh. Separate input and publication-settlement guards.
- [ ] Remove obsolete editor error variants and public methods only at coherent
  caller cutover. Do not leave two production row engines behind compatibility aliases.

### 3. Add the Svelte boundary

- [ ] Add a small adapter under `packages/folder/src/svelte/`, the `/svelte`
  export, optional Svelte peer, and necessary build/typecheck configuration.
- [ ] Add read-through getters, shared tracking, and wrapper identity reuse.
  Keep core/platform imports free of Svelte acquisition and runtime requirements.
- [ ] Verify actual effect lifetimes and DOM function bindings, not only a fake
  listener or compiled snippet. Include gate removal, remount, and refused input.

### 4. Migrate callers and remove row-specific handoffs

| Caller | Launch points and changed responsibilities |
| --- | --- |
| Todos | `src/lib/todos.svelte.ts`, `todo-editor.svelte.ts`, `routes/components/TodoDetail.svelte`, `TodoStatus.svelte`: replace mirrored state, partial changes, save halts/adoption, and row/source owner transfers. Keep retention, file operations, and close consent. |
| Honeycrisp | `src/lib/notes.svelte.ts`, `row-session.svelte.ts`: title, folder, pin, rich body, and raw row text share one owner. Stop replacing the row owner with a file session on invalid reads. Keep arbitrary-file sessions and prove rich-body representability and native shutdown. |
| Capture | `src/lib/captures.svelte.ts`, `draft.svelte.ts`: preserve application draft retention while submitting complete rows through the shared queue. |
| Whispering | `src/lib/library.svelte.ts` and its draft helpers: replace canonical/raw acquisition branches for rows; preserve recording/media and ordinary file lifetimes. |
| Vocab | `src/lib/word.svelte.ts`: migrate acquisition, observation, and saving without reseeding newer form drafts. |
| Evidence callers | `packages/folder/evidence/edit-handle/` and `evidence/opfs/main.ts`: update native, Vanilla, Solid, and Svelte caller examples and protocol expectations. Label historical prototypes rather than advertising retired APIs. |

Review each application's choice of immediate submission or continuing local
draft. Do not impose one form buffer policy on every application. Closed-row
commands may retain `table.update` where source-preserving assignment is their
intent; this decision removes patch commands from the live editing workflow,
not from the entire table API.

### 5. Verify and close the cutover

- [ ] Run core, affected application, and Svelte tests and typechecks through Bun.
  Root app development uses `bun dev:<app>`.
- [ ] Run browser/desktop journeys for raw repair, transient read recovery,
  external deletion, continuing drafts, selection changes, and native close.
- [ ] Verify existing-row publication and ordering on OPFS, Bun, and Rust-owned
  desktop storage. Mock evidence alone does not establish the native claim.
- [ ] Measure typing/cursor/IME behavior and write/history cost with immediate
  submission. Choose application buffering if evidence requires it; do not
  introduce an adapter shadow or a second publisher to address performance.
- [ ] Search old row methods, wrappers, error branches, and imports after migration.
  Delete only code with no remaining arbitrary-file or application-policy owner.
- [ ] Rewrite current package READMEs and examples at cutover, reconcile ADR
  implementation notes, apply local post-implementation review, and retire this
  spec when all acceptance work is complete.

## Acceptance checks

| Case | Required observation |
| --- | --- |
| Unknown nested metadata; change title using a whole-row spread | Unknown values and body survive; complete omitted key is deleted |
| Caller mutates submitted object after set returns | Held input and queued bytes remain the owned capture |
| Structured and raw setters return before their writes finish | Public readable snapshot already describes accepted input; valid text, fields, and body round-trip as one capture |
| Schema-invalid representable field | Accepted save; invalid row gate; latest text available for repair |
| Malformed or unsupported readable frontmatter on acquisition | Owner exists and raw repair is possible |
| Unrepresentable structured input | Synchronous refusal with no input or publication change |
| Raw string that UTF-8 encoding would normalize | Input retained, failed publication diagnostic, no lossy write; corrected input can publish |
| A active; unencodable raw B pending | B is invalid/public while readable; A remains saving; B fails on its turn with no idle gap or lossy write |
| A active, B then C pending | A publishes, then C; B is never submitted; no idle gap |
| A active, B public, then A's receipt | B stays public; no active-attempt rollback or disk/local mixture |
| A fails or is Unconfirmed with B pending | Chain pauses; B retained; no automatic retry |
| Failed A, held B, refresh reads C | Availability recovers; B and failure stay; C does not replace B |
| Input changes while read completes | Current read availability still updates; old input is not adopted |
| Read began before save settlement | Old success or failure cannot become current; rerun where required |
| Failed read completes before write settlement | Failure closes gate; receipt does not reopen it; subscribed settlement requests fresh observation |
| Read begins before settlement and completes afterward | Result is stale, never installed; guarded reread determines availability |
| Setter accepts B while unreadable | Public row has only error; B stays private and becomes public when readability recovers without eligible adoption |
| Two subscribers remain during manual recovery | Refresh restores availability without detaching or replacing owner |
| Last subscriber leaves during publication | Watcher stops; publication and retained failed input continue |
| Imperative read, repeated wrapper, unmount/remount | No eager subscription, no value cache, correct attach/detach and reread |
| Same-value setter after uncertainty | A new attempt starts; old command outcome is never confirmed by observation |
| Delete between acceptance and publication | NotFound; no recreation on any backend |
| Failed NotFound B; file explicitly recreated as C; refresh | Row exposes B when readable; save remains failed; disk C is not adopted |
| Refresh with zero subscribers or during an older read | One-shot fresh observation; completion is not an older request's pass |
| Setter followed immediately by close | Close sees saving and waits; failure preserves input or needs deliberate discard |
| Conditional UI removal with application draft | Draft above conditional survives; old core text is not its repair value |
| Raw/structured edits interleaved, including a mode switch | One queue, latest whole input, no save echo or old structured overwrite |
| Real textarea/component function bindings | Correct live values and setter behavior through invalid/unreadable recovery |
| Native rename/delete/close and uncertain path outcomes | Existing per-file conditions and consent preserved; no hidden restoration |

## Independent review and adjudication

Two reviewers first received the outcome, requirements, and current callers
without the proposed signatures. Their initial verdicts were preserved before
the full-proposal challenge. Both passes were read-only.

- Codex `gpt-6.1-sol`, high effort: independently favored a fixed-row owner,
  accepted input separate from observation, and a shared row/raw publisher.
  Its challenge found the concrete refresh need in Todos' Check again and
  Honeycrisp's focus/reobserve callers. It supported the final minimal surface
  with refresh and no public disposal/settlement protocol.
- Claude `claude-opus-5-5`, high effort, session
  `5a6f70dd-5f0f-429d-ab34-9a7f2db25712`: independently favored dropping the
  baseline model and keeping complete input with latest-pending publication.
  Its initial proposal continued newer pending input after older failure; the
  focused challenge accepted the chosen pause rule and invalidation-only
  subscription. Its watcher concern is resolved by subscriber-owned observation.

Accepted findings: complete parsed output retains unknown fields; row availability
does not destroy input; refreshed disk C cannot replace failed held B; all admitted
work is synchronously saving; stale reads cannot roll input backward; expected
refresh failures remain row state; same-value setters are explicit renewed intent;
automatic form timers pause after failure; Unconfirmed is presented as uncertainty.

Rejected alternatives: a public baseline/isDirty/adopt protocol for ordinary LWW
editing; continuing B automatically after A fails; a separate raw owner; a
public settled/dispose method when subscriptions and a small application await
helper cover the actual lifetime. App-owned continuing drafts remain an explicit
product choice. Neither reviewer established runtime correctness by inspection.

Names (`RowEditor`, `ReactiveRowEditor`, `row`, `save`, `set`, `setText`,
`refresh`) are chosen for this contract. The internal read facts remain separate
even though the public row union combines their UI consequence. Failed status
means the publication chain stopped; UI must inspect an uncertainty error before
claiming a definite failed write.

The user's subsequent revision removes standalone text and the value wrapper.
The flattened readable variants now expose one snapshot's text, fields, and body;
unreadable exposes only error. The [revised adversarial-review brief](20261005T015758-complete-row-editing.adversarial-review.prompt.md)
requires a focused challenge of synchronous local acceptance, publication receipts,
disk adoption, and private retention while unreadable. Earlier review endorsements
describe the preceding surface. Both reviewers then challenged this revision.
Codex found no blockers. Opus supported the snapshot rule and requested sharper
read-currentness, queued encoding failure, structured input extraction, deliberate
discard, deletion recovery, and binding-teardown wording. These corrections are
incorporated above. Raw mode preference keeps repair mounted after validation
succeeds; it introduces no second input owner.

## Evidence from this planning pass

- `bun test packages/folder/src/canonical.test.ts`: 26 passed, 0 failed,
  56 assertions. This verifies the existing codec, not the replacement owner.
- Installed Svelte compiler: direct textarea function binding, bindable raw
  component, and component caller function binding compiled with zero warnings.
  This does not verify mounted DOM, selection, or subscription behavior.
- Documentation hygiene baseline: 103 existing findings before this pass.
  Final report: 102 findings, with the missing implementation note on the edited
  application-policy record resolved and no additional findings. The remaining
  failures are unchanged from the captured baseline.

No replacement runtime, application migration, or lifecycle acceptance case has
been implemented in this pass. Establish those facts in the execution waves.
