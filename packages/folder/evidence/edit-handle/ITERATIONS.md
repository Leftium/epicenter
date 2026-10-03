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

## Wave 6: canonical editor, retained lifetime, unconditional save

This wave supersedes wave 5's proposed guarded save and raw editing mode. The
accepted outcome is ordinary files edited by people and tools, with advisory
notifications to open editors. `save()` replaces whatever occupies the fixed
path when the write lands. The baseline compares content; it authorizes no write.

The coordinator delegated the engine and the framework consumers to separate
Claude Code clones, then verified and integrated the completed artifacts. A
resumed engine assignment repaired callback ordering, and a further assignment
implemented the content-adoption and typed-key improvements. Independent OpenAI
and Claude reviews explored the destination before testing the concrete API.
Later challenges used actual callers and executable counterexamples.

### Current shape

```text
proposed production owner: folder.tables.todos.edit(stem)
implemented evidence: createCanonicalEditors(folder, definition).tables.todos.edit(stem)
    `-- Promise<Result<editor, OpenError>>
        `-- editor
            |-- get: immutable current state
            |-- subscribe: attach view, return its unsubscribe
            |-- change: local fields/body, invalid intermediate input allowed
            |-- save: publish complete canonical document once
            |-- refresh: reread fixed path
            |-- adopt: take reviewed current content, never restore history
            `-- dispose: stop watcher, finish admitted save, release callbacks
```

Watching starts before the opening read. It continues even with no subscribers.
A form owns the retained editor and shares it among controls. Views mount and
unmount independently. Methods close over state and do not depend on `this`.
Opening examples destructure the Result's `data` and `error` before using it.

The codec owns exact canonical representability. The editor owns validity at
opening and saving, local draft preservation, one admitted write, and honest
receipts. The app owns save timing and review UI. Storage owns publication and
notifications. No framework defines when an editing interaction starts or ends.

### Adversarial alternatives

| Alternative | Deletion prize | Decision and concrete cost |
| --- | --- | --- |
| Start watching with the first subscriber; stop with the last; delete `dispose` | Removes explicit editor lifetime | Rejected. A retained editor with zero views misses external B and later shows or saves stale A. A permanent owner subscription or mandatory refresh restores the obligation. |
| Freeze the local draft until manual refresh | Removes clean following rules | Rejected. Every untouched control requires another read or reload decision to display observed values. |
| Mutable change recipes or functional document transforms | Removes the fields/body patch shape | Rejected for these callers. Mutable recipes introduce cloning and callback semantics; transforms make every control preserve unknown metadata with object spreading. |
| No-op a clean save | Avoids unnecessary writes | Rejected under the accepted save contract. Explicit Save must canonicalize clean styled text and publish the complete draft. Autosave/quit decide whether to call it. |
| Adopt any historical revision unconditionally | Deletes stale-content refusal | Rejected for current-file review. It restores content the file no longer holds and needs a separate meaning. Current-content adoption accepts formatting-only differences and trusts only the internal read. |
| Remove opening cancellation and rely only on generation checks | Removes one option | Rejected. A generation check cleans up a late successful open; abort releases the watcher promptly during a pending read. Both cover different moments. |
| Type raw local values as the schema row | Removes value narrowing in controls | Rejected. Intermediate invalid values are actual draft content. Accepted typed declared keys with broad canonical values instead. |
| Hash submitted source before every write | Gives an unconfirmed attempt a hash | Deleted. Storage hashes confirmed captures; unknown content comparison already has exact canonical source. |

One review still preferred no-op clean saves and historical restoration. Those
choices conflict with the selected meaning of Save and Take current file; review
agreement was not required. The current destination survived the consequential
alternatives without claiming that no better API could ever exist.

### Repairs established by regression tests

Initial subscription and later notifications now share a nonrecursive delivery
loop. Subscription calls are independent, even with the same callback. Reentrant
changes may coalesce intermediate states; the final delivered snapshot is current.
This is current-state observation, not a log of every transition.

Admission precedes `saving` notification. Disposal from that notification waits
for the admitted save. Settlement clears only its own admission before delivering
its outcome, so a subsequent save begun in that callback stays admitted. Terminal
delivery releases callbacks after the final save outcome. New terminal subscriptions
receive one snapshot and stay unretained.

A save captures B at admission. Later typing C stays dirty against B's receipt.
A matching reread after an unknown reply establishes content equality and may
make the draft clean, but never promotes unknown history to confirmed success.
Reads begun before a receipt are invalidated and repeated. Missing, invalid,
unsupported, and unreadable observations preserve local input.

`adopt` matches fixed path and canonical content against the latest valid read.
It follows that internal revision, never supplied fields or source. Formatting-only
rewrites succeed; different content refuses. Save remains unconditional regardless
of adoption or how recently a person reviewed the file.

### Local cumulative review

Files read for the final ownership and inlining pass:

```text
packages/folder/
|-- src/{contract,capture,files,observer,paths,reading,table}.ts
`-- evidence/edit-handle/
    |-- README.md
    |-- ITERATIONS.md
    |-- canonical-codec.ts
    |-- canonical-codec.test.ts
    |-- canonical-editor.ts
    |-- canonical-editor.test.ts
    |-- canonical-editor.test-d.ts
    |-- canonical-editor-api.md
    |-- canonical-callers.md
    |-- canonical-dev.ts
    |-- canonical-build.ts
    `-- canonical-web/
        |-- main.tsx
        |-- vanilla.ts
        |-- SolidPanel.tsx
        |-- SveltePanel.svelte
        |-- status.ts
        |-- memory-folder.ts
        |-- harness.ts
        |-- repair.ts
        |-- todos.ts
        |-- todo-editor.ts
        |-- dom.ts
        |-- index.html
        `-- style.css
```

The editor owns one lifetime and one fixed path. The codec earns its parse boundary.
The three views are real independent callers; their small draft-value helper owns
DOM-specific narrowing, while shared error text and DOM creation avoid repetition.
The status view owns review choices, not write authority. The harness owns simulated
transport gates and external writers, not production watcher guarantees. The
wrapper's duplicated definition is accepted only as experiment isolation; the
production table already owns it and should expose `edit` directly.

The worker clones used the committed definition contract. Integration adapted
`DataDefinition` to the live `FolderDefinition` and removed obsolete definition
IDs without editing the unrelated production migration. Existing wave 4 evidence
remains runnable as a comparison rather than retaining compatibility in this API.

Verification: all 83 experiment tests pass with 376 assertions, up from the
task-start 56 tests. Folder typecheck passes, Svelte check reports zero errors
and warnings, Biome passes, and the canonical Vite build passes. The intentional
throwing-observer regression produces a logged error while the test passes.
[Browser journeys](./canonical-callers.md#observed-browser-evidence) cover the
final engine; [the screenshot](./canonical-journey.png) shows C still drafted
in all three views after the receipt for B.

### Remaining evidence limits

The browser folder is in-memory. It uses real schema inspection and capture
shapes but simulates hints, reply loss, and delayed reads. A Bun integration test
proves real file replacement and explicit rereading, not native external watching.
This wave does not establish Rust watcher delivery, IndexedDB cross-tab updates,
or OPFS observation. Real collaboration remains a separate CRDT requirement.

`change` still formats and reparses a complete document per input. Large-body
performance needs measurements before choosing a cheaper path. `observation`
briefly predates a receipt until the follow-up read lands; the UI must describe
it as the latest read, not an atomic view of disk. Neither limit changes the
selected ownership or save semantics.

## Earlier guarded-demo limits

The native folder's hash check is best effort against outside writers. The
other writer uses `node:fs`; the harness explicitly supplies its change hint.
Lost replies are simulated. Browser observations do not establish a stronger
native concurrency guarantee or production migration readiness.
