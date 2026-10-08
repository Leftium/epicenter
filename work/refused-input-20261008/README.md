# Refused structured input may revert

Baseline: 403257fe50. The user accepts discarding a structured edit refused before admission, provided the refusal is visible. Accepted input and failed or unconfirmed publication remain retained by the native row editor. No redesign of native row ownership is assumed.

## Files read before analysis

```text
.agents/skills/
|-- adversarial-review/SKILL.md
|-- computer-use-driven-iteration/SKILL.md
|-- consult-claude/SKILL.md
|-- delegate-claude/SKILL.md
`-- prototype/SKILL.md
packages/
|-- folder/src/editor.ts
|-- folder/src/canonical.ts
`-- ui/src/
    |-- input/input.svelte
    `-- textarea/textarea.svelte
apps/whispering/
|-- AGENTS.md
|-- README.md
|-- src/lib/row-editing.svelte.ts
|-- src/lib/workspace/browser.ts
|-- src/lib/library.svelte.ts (targeted lifecycle search)
`-- src/routes/components/
    |-- RowSaveStatus.svelte
    |-- TransformationDetail.svelte
    |-- RecordingDetail.svelte
    |-- TranscriptCard.svelte
    `-- FileView.svelte
```

Independent GPT and Claude Opus reviewers examine the dropped retention promise. The reviewed surface stays stable while they form their initial judgments. Todos is comparison evidence, not this implementation slice. Existing dirty session, shell, generated binding and TodoStatus work is outside scope. Device staging is captured separately in a task-owned temporary file.

## Baseline browser evidence

A new Chrome Guest tab on http://127.0.0.1:25851/transformations?fixture=tone opens a fresh site-local OPFS folder. The coordinator created Clean up and renamed it Refusal behavior acceptance. Title/body edits saved; Source showed the same full file, and browser reload/reopening retained the accepted content. Fixture audio was enabled but no recording, hardware or provider request was exercised.

Path: transformations/uz2aefthz9.md. Accepted body: Accepted instructions before refusal, followed by Keep this body after reopening. Native computer input could not carry a lone surrogate: setValue timed out, the computer tool reset, and a fresh observation showed the accepted body unchanged. This is a tool limitation, not evidence that a refusal notice appeared.

The coordinator inspected installed Svelte bind_value: it calls set, awaits tick, then compares input to get and restores the getter value even without reactive invalidation. The GPT reviewer also executed a probe mounting the actual shared Input and Textarea, both reverting after refusal with a constant getter. Automated binding evidence is separate from computer-use acceptance.

## Adjudication before implementation

Both fresh reviewers independently recommend removing app-held structured refusals without changing native RowEditor. Claude session 075c4e5e-7d29-4987-b0b7-60c36bece114 completed on Opus 5.5, with one denied outside-directory Glob recovered through repository-local installed source. Its focused challenge completed without denials. GPT also challenged deleting control origins and found no necessary guarantee requiring them.

Accepted destination: guarded complete set(next), caller-owned textarea newline restoration, direct accepted-row reads, one rejection notice independent of publication state. Delete held text, cross-control comparisons, field origins, refused save status, selective discard and refusal-dependent unsaved/close/run accounting. Keep operation/lifetime fences and accepted invalid raw Source. TranscriptCard must show the notice even for an otherwise saved row.

The rejection message names the previous accepted input, not saved file content. A failed accepted write and a later rejected edit show both facts. Earlier save completion never clears a later rejection. Repeat refusals should re-announce without retaining input; a fresh diagnostic object can key the alert, without a counter or input buffer. Any successful reload clears the diagnostic, including the existing clean recording observation reload: there is no pending rejected value to protect, and adding reload provenance would retain complexity for a notice only. Failed reloads and gated no-ops do not clear it.

Svelte rollback assertions wait for the next task, covering the actual post-event binding reconciliation rather than synchronous flush only. The browser fixture must demonstrate that the assigned test value is not well formed before dispatch, preventing accidental replacement-character normalization from masquerading as refusal evidence.

The coordinator additionally exercised malformed Source and repair in the actual browser: bad YAML remained visible with Instructions disabled; replacing it with the original valid file restored eligibility while Source stayed selected. Baseline owner tests: 12 pass. Baseline mounted views: 15 pass.

Implementation delegated to /tmp/refused-input-whispering-20261008, dedicated clone at403257fe50, frozen dependencies and folder addon prepared. Brief is task-owned temporary file. Allowed scope is Whispering's row owner, actual panels/status, affected library accounting/comments and tests/docs. Native row storage, settings, other apps and unrelated live work stay outside the assignment. A temporary real-control refusal fixture is separate from production changes.

## Completed artifact and final review

Files read for the cumulative review, before analysis:

```text
.agents/skills/
|-- post-implementation-review/SKILL.md
|-- git/SKILL.md
|-- svelte/SKILL.md
|-- svelte/references/component-ui-patterns.md
|-- testing/SKILL.md
`-- agent-instructions/SKILL.md
apps/whispering/
|-- README.md
|-- ARCHITECTURE.md
`-- src/
    |-- lib/
    |   |-- row-editing.svelte.ts
    |   |-- row-editing.test.ts
    |   |-- row-slot.test-support.ts
    |   |-- library.svelte.ts
    |   |-- library.test.ts
    |   |-- transformations.test.ts
    |   `-- workspace/desktop-sequences.test.ts
    `-- routes/components/
        |-- FileView.svelte
        |-- RecordingDetail.svelte
        |-- RowSaveStatus.svelte
        |-- TranscriptCard.svelte
        |-- TransformationDetail.svelte
        `-- row-views.mounted.test.ts
docs/adr/
`-- 0507-editor-views-compose-current-input-and-own-only-interaction-state.md
work/refused-input-20261008/
|-- README.md
|-- claude-initial.md
|-- claude-challenge.md
`-- worker-report.md
```

The completed worker patch was checked and applied only after completion. The
coordinator reviewed every changed file in its caller context. The native editor
owns accepted content and publication; the app owner still earns its place through
view preference, admission and release/reload fences. RowSaveStatus translates
publication and the independent notice for people. No native storage redesign or
shared control change is needed. Newline restoration belongs beside the textarea
that changes the representation; command replacements remain exact.

Two corrections were announced before editing: inline TranscriptCard's status
condition (a saved row can have a notice), and store a fresh reason-only diagnostic
object, keyed in the alert, to recreate it on identical refusals. A mounted test
checks a new alert node and unchanged accepted text on repeated refusal. This
checks DOM behavior, not a specific screen reader. Rollback assertions await the
next task. No rejected input or control origin remains.

ADR-0507 and existing Svelte guidance now distinguish the app's chosen refusal
policy. Other apps' retained input is unchanged. Accepted input whose save fails
still stays in the native row, and unencodable raw Source remains available.

## Integrated browser acceptance

Computer-use actions were performed in a dedicated Chrome Guest tab. A reload
of the original 127.0.0.1 origin failed opening its existing OPFS directory with
a missing ready-marker message. This is an observed folder-bootstrap blocker,
not attributed to this patch or repaired here. A fresh localhost origin opened
successfully. The coordinator created transformations/ulh51ele5o.md and edited
its title to Direct row acceptance, with a two-line accepted instructions body.

A temporary, labelled development fixture assigned String.fromCharCode(0xd800)
to each actual title/body control. It checked that the DOM value was not well
formed before dispatching the actual input event. Computer-use clicked the
buttons; both controls reverted, the notice appeared, save status remained In
history, and Source showed the unchanged accepted title/body. Repeated refusal
recreated the alert. Reload from file kept the content and cleared the notice.
Another rejected body followed by accepted typing cleared the notice and saved
Accepted after refusal / Kept in the row. The fixture was removed, and reopening
the production panel showed those saved values with no fixture controls.

An optional model input containing one space became empty and serialized as null.
Malformed Source stayed visible and saved, disabled Instructions, and displayed
its parse error. Repairing the full Source restored Instructions eligibility
while retaining the selected Source tab. No microphone, hardware recording,
native desktop quit or external provider was exercised in this slice. Rare
malformed text was programmatically injected through real controls because the
native input tool cannot transport it; natural OS paste is not claimed.

## Verification

- Completed clone baseline at 403257fe50: 441 pass, 27 fail. Completed worker:
  442 pass, the same 27 failures, reported compared by failing-name diff.
- Integrated live broad suite: 443 pass, 26 fail across 469 tests. The live
  checkout includes unrelated concurrent dirty work. Failures concern existing
  definition/first-launch checks and scripted native shell operations; this is
  not a green whole-suite claim. The differing aggregate from the clone is not
  attributed to this editor patch.
- Integrated mounted panel suite: 15 pass, 0 fail, including repeat notices,
  rollback, failed accepted saves, retired controls and CRLF preservation.
- Integrated browser/native TypeScript: no errors or warnings.
- Integrated production build: exit 0, with temporary fixtures removed.
- Scoped whitespace check passed. The pre-existing staged device owner patch
  is byte-identical to its task-start capture. Unrelated work is excluded.

Logs are task-owned /tmp/refused-input-integrated-{src,mounted,types,build}.log.
The source clone and completed worker report remain separate from live acceptance.

Implementation and doctrine committed as `eb1683b6ac`. The task stops after this
bounded Whispering wave; other apps and native storage retain their existing
contracts. The folder-opening blocker remains visible and outside this change.
