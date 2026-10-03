# Edit handle review evidence

This experiment continues thread `01a10008-a12f-7b11-ada9-44a1bcb77278`.
It modifies disposable demo data. It does not migrate production callers.

## The boundary that survived review

A retained edit owns one file's draft, displayed baseline, observations, and
admitted save. A form's controls share that edit explicitly. Frameworks own
their subscriptions; the app owns draft retention and save timing.

An independent immediate action patches the displayed source and conditionally
writes against that same capture. It acquires no edit lifecycle. The app owns
pending admission and the chosen checkbox value across rerenders.

The original Todos toggle joins a retained editor when one exists. Otherwise
it patches the current file through `table.update`. The demo's independent
command deliberately has different behavior. Production migration must settle
that app policy rather than replacing every toggle mechanically.

## Wave 1: implementation and counterexamples

Claude implemented in an independent clone. Independent Codex and Claude
reviews traced the real callers. Computer use exercised the three framework
views against a disposable native folder through the demo HTTP transport.

The browser demonstrated duplicate checkbox admission after a file hint,
missing files misreported as unreadable, and receipt wording that claimed a
historical version was still current. The reviewers also reproduced writes
redirected by another path's reviewed snapshot, reentrant disposal returning
before admitted work, and a saved lone surrogate remaining dirty.

The initial 17 tests passed despite those defects.

## Wave 2: repairs and another challenge

The coordinator reproduced 25 passing tests with 130 assertions, a full Vite
build, zero Svelte/Solid diagnostics, and a passing folder typecheck. Matching
the demo's Node types to the repository fixed the introduced typecheck failure.

Browser retesting confirmed pending checkbox protection, rejected control
values restored in all three frameworks, distinct missing and unreadable
states, newer typing retained across a held reply, historical receipt wording,
and drafts retained across control remounts.

A fresh reviewer pair retained the API and challenged separate uncertainty
recovery. The tracker did not cancel or fence an unknown write. It automatically
adopted an earlier attempted version as the baseline, but required special
discard refusal and resolution rules. The missing-file case exposed a UI route
with no discard action; the engine itself still allowed explicit baseline
resolution.

We accepted deleting that recovery protocol. A lost reply remains historical
`lastSave` information. Subsequent versions follow ordinary observation rules.
The cost is explicit review when an earlier unknown attempt appears while newer
typing remains dirty. Discard remains refused while a save is admitted.

## Wave 3: accepted

The coordinator reproduced 31 passing tests with 161 assertions, the full Vite
build, zero framework diagnostics, the folder typecheck, and Biome checks.
The tests include ordinary failure, conflict, and lost-reply autosave pauses.

Computer use held B's reply, typed C, unmounted all three views, and released B.
C published once while the views were absent. Remounting showed C everywhere.
Typing, rereads, hints, and remounts did not restart paused autosave. Resume
respected incoming review; reviewed resolution then published once.

An unknown result preserved newer C and presented earlier B for ordinary
review. Discard worked after uncertainty with a missing file, preserving the
missing observation and historical unknown result. Admitted saves still
refused discard. Late writes after discard adopted cleanly without preparing
an undo.

The final review kept the autosave lifetime and contracted its notification
API. The coordinator replaced its listener registry and getters with one
pause-change callback. The helper returns only `start`, `stop`, and `resume`.
The edit handle remains the sole framework store. Tests and focused browser
retesting passed after this contraction.

The final Codex pass was an informed follow-up; the final Claude review began
in a fresh session and then challenged the callback contraction. Both found
no correctness blocker or further grounded API change for these callers.
We stopped after the intended journeys passed, rather than claiming that no
better design could exist.

## Wave 4: Svelte runes caller

The Svelte panel no longer reads the handle as a store through `$edit`. A
`$derived.by` captures the current `edit` prop and returns a reader that
calls a `createSubscriber` over that handle's `subscribe`, then returns its
`get()`. A second `$derived` calls the reader. The outer value changes only
when the prop is a different handle; the inner value changes with each
notification. Capturing the handle keeps each subscription paired with the
handle it reads. The explicit controls and refusal repaint are unchanged.

Independent Codex and Claude reviews, plus a runtime probe of prop identity
changes and unmount, accepted this shape. They rejected adding a shared
helper, a module-level handle cache, `bind:` directives, or a mirrored state
snapshot. Those alternatives were never
implemented. This wave replaces the existing Svelte store consumer. The
engine behavior, the other callers, and package dependencies stay the same.

The worker and coordinator each ran 31 passing tests with 161 assertions,
zero svelte-check errors or warnings, the Vite build, the folder typecheck,
and a clean Biome check. Compilation caught a flaw in the reviewed sketch:
a derived named `state` shadows the `$state` rune, so the implementation
names it `current`.

A post-implementation Codex pass compiled the actual component and found
zero warnings and no store runtime calls. It retained the folder edit
factory because it owns path validation, source-preserving patching, and
conditional publication. Removing it would move those rules into callers.
The prop-replacement probe used installed client internals; browser
acceptance covers the actual mounted controls, not prop replacement.
Computer use exercised `localhost:5248` against root `vnPao3` on commit
`b0f79138bf` plus this migration. Structured and raw edits synchronized
across all three views. Tagged title, done, and priority refusals restored
the actual reading; body-only changes remained safely patchable. Malformed
raw source disabled structured controls, and raw repair restored them.
The independent second Svelte draft saved while the shared dirty draft
remained incoming for review.

With autosave B's reply held, newer C stayed drafted beyond 400 ms. All
three views unmounted; releasing B published C exactly once in the visible
event log. Remounting showed C everywhere. The harness was reset to clean
root `gPE6Nl`, all views mounted, autosave off, and no gates held or armed.
No new failure was observed. The simulated transport limits below still
apply.

## Wave 5: canonical document design

The user permits canonical frontmatter formatting, including removal of
comments and quote spelling, and leaves a whole-file editor optional. The
new candidate makes fields and body the table draft. Exact file replacement
remains the repair boundary. This is a design under test; the interactive
demo still implements the source-preserving wave-4 handle.

Fresh independent reviews considered both source-authoritative and parsed
document drafts. A sequential challenge tested the parsed destination after
the raw editor requirement became optional. The source-authoritative
alternative retains intermediate malformed YAML and exact text editing, but
also retains source/field reconciliation. Those promises no longer justify
that machinery for the primary table editor.

The proposed call sites are:

```ts
const edit = folder.tables.todos.edit(displayed);
edit.update({ fields: { title: 'A' } });
edit.update({ body: markdown });
await edit.save();
await edit.save(reviewed); // Keep my changes: one conditional publication
edit.reset();
edit.reset(reviewed);      // Take this reviewed document, without writing
await edit.refresh();
await edit.close();
```

These names are proposals, not existing package methods. The core remains
framework neutral with `get` and `subscribe`. Solid and Svelte use their
native reactive primitives; Svelte uses runes, not stores. Each `edit` call
still owns an independent lifetime that callers may share explicitly.

`save(reviewed)` captures the complete local candidate and the reviewed
capture at admission. It does not move the baseline before publication.
A later external C makes a save against reviewed B conflict; nothing retries
against C. Canonical submitted B becomes the receipt baseline while newer
local C stays drafted. Lost replies remain unknown history. Reset remains
refused while a save is admitted.

The editable document must contain every key, including unknown metadata
and schema-invalid declared values. The validated `TableReading.fields`
projection cannot supply it. Schema issues remain diagnostics; application
submission policy may require validity. A min-length constraint must not
erase the intermediate input `A` on the way to `ABC`.

The codec admits JSON-domain frontmatter before any lossy YAML conversion.
It sorts declared keys by definition and remaining keys deterministically,
sorts nested mappings, preserves arrays and signed zero, and keeps body
text opaque. Unsafe integers, custom tags, binary values, sets, non-string
mapping keys, cycles, and expansion beyond a bounded budget must refuse.
One such value makes the complete row unavailable for structured editing.
Exact `files.replace` is the repair escape hatch. This cost is deliberate;
comment loss does not authorize value loss.

Installed YAML probes confirmed that unknown tags can produce warnings
without errors, unsafe float-form integers can already round under
`intAsBigInt`, and integer negative zero needs its scalar spelling to retain
its sign. Ordinary object conversion can also lose non-string key identity.
The existing `composeSource` and its enumerable-key equality therefore
cannot become the canonical codec without replacement.

Opening a noncanonical file stays semantically clean, so autosave does not
rewrite it merely because it was opened. Explicit Save may canonicalize a
clean document. Semantic equality includes every unknown key and the opaque
body. The codec does not weaken the native best-effort byte-hash write guard.

One reviewer proposed automatically advancing a dirty draft's baseline on
an external formatting-only change. That is not accepted in this experiment:
retain the actual guarded capture and expose the new observation for review.
Equal fields alone must never silently choose a newer publication target.
The review UI can explain a presentation-only change without a raw editor.

The deletion prize is span patching, a raw/document editing mode, reparsing
on every keystroke, `input`/`setSource`, and a separate keep/rebase operation.
The introduced work is one strict codec plus document equality. Field
removal and the exact reset naming remain to be exercised in real call sites.
Next, a bounded isolated codec prototype tests data preservation and
idempotence before changing the interactive engine. The engine migration
must then prove canonical receipt/newer-input and stale-reviewed-capture
races through the native folder and the three framework callers.

The isolated codec prototype was integrated as `canonical-codec.ts` and
`canonical-codec.test.ts`. It walks YAML nodes before conversion and emits
quoted keys with deterministic flow values. It preserves signed zero and
unknown metadata, refuses unsupported YAML, and retains well-formed body
text exactly. The coordinator added refusals for malformed body strings,
plus tests for unsafe decimal and exponent integer spellings that ordinary
Number parsing rounds. These are codec checks, not evidence that the new
handle API or publication races have been implemented.

The local post-integration review read:

```text
packages/folder/
|-- src/
|   |-- markdown.ts
|   `-- table.ts
`-- evidence/edit-handle/
    |-- README.md
    |-- ITERATIONS.md
    |-- package.json
    |-- edit-handle.ts
    |-- folder-edits.ts
    |-- canonical-codec.ts
    `-- canonical-codec.test.ts
```

The codec earns a boundary because it owns the unsafe YAML parse and
canonical serialization. It contains no lifecycle or schema policy. The
document is not yet frozen: immutable ownership belongs to the future
handle. Prototype limits are explicit: finite safe integer numbers plus
ordinary JS fractional semantics, UTF-16 code-unit key order, refusal of
every YAML warning, 100 alias expansions, and 10,000 converted nodes. These
limits are experiment choices, not a settled production compatibility
contract. Field order currently arrives as a string array rather than a
production definition object.

Verification after integration: all 56 experiment tests passed, including
25 codec counterexamples. The experiment TypeScript check and Biome check
passed. No framework caller changed in this wave, and no new browser
acceptance is claimed. Existing browser evidence belongs to wave 4.

## Limits

The native folder's hash check is best effort against outside writers. The
other writer uses `node:fs`; the harness explicitly supplies its change hint.
Lost replies are simulated. Browser observations do not establish a stronger
native concurrency guarantee or production migration readiness.
