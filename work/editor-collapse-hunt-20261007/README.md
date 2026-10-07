# Editor consumer collapse hunt

Baseline: e155539b3c. The user requested independent adversarial reviews of related editor occurrences, followed by a collapse pass. Honeycrisp's current shape is evidence, not a requirement to erase application information.

## Files read before adjudication

```text
.agents/skills/
|-- adversarial-review/SKILL.md
|-- collapse-pass/SKILL.md
|-- consult-claude/SKILL.md
|-- delegate-claude/SKILL.md
|-- post-implementation-review/SKILL.md
|-- rethink/SKILL.md
|-- svelte/SKILL.md
`-- testing/SKILL.md
apps/
|-- README.md
|-- capture/
|   |-- README.md
|   |-- package.json
|   `-- src/lib/
|       |-- draft.svelte.ts
|       `-- components/CaptureDetail.svelte
|-- honeycrisp/src/lib/note-editor.svelte.ts
|-- todos/
|   |-- README.md
|   |-- package.json
|   `-- src/
|       |-- lib/
|       |   |-- todo-editor.svelte.ts
|       |   |-- todo-editor.test.ts
|       |   `-- todos.svelte.ts (targeted caller search)
|       `-- routes/components/
|           |-- TodoDetail.svelte
|           `-- TodoDetail.mounted.test.ts (test inventory)
`-- vocab/
    |-- README.md
    |-- package.json
    `-- src/
        |-- lib/word.svelte.ts
        `-- routes/components/EntryCard.svelte
packages/
|-- capture/src/document.ts (codec signatures)
`-- folder/src/svelte/row-editor.svelte.ts
```

Two fresh read-only reviewers independently examine Todos, Capture and Vocab. A focused challenge examines held-field changes and late events. Zhongwen lives in another repository; its conditional-save policy requires separate grounding before applying this pattern. No unrelated dirty work is authorized by this hunt.

Coordinator baseline: 18 TodoEditor tests pass; 13 mounted Todo/departure tests pass. Protected device staging and unrelated Todos/Capture/Vocab diffs are captured in task-owned temporary patches.

Decisive distinction: accepted content is derivable from the row; unsent refused text, unfinished forms, operation identity and rich interaction history are separate information. Deleting their ownership would change behavior or lose input.

## Adjudication

Independent GPT review recommends the direct complete-row Todo setter. Claude Opus 5.5 initially proposed a compose callback, Result wrapper and generic slots while retaining scalar methods. Its informed challenge withdrew those additions: no required guarantee breaks with complete `set(next, {control?})`. Claude session: `596d47e3-6497-4607-bd62-a5ac38d749db`, both turns completed without errors or permission denials.

Accepted Todo destination: public row/save and refused-input map; guarded complete set with optional title/notes origin; no mutable native facade or scalar editing methods. Preserve source preference, gate ordering, LF/CRLF handling, deliberate reload semantics and semantic list toggle's publication wait. Gate refusal creates no held text. Only representational refusal from a tagged control holds the value. Changing another held field is rejected; saving an unchanged accepted value keeps its refusal.

Vocab source preference relocation is rejected for now: shared Textarea retirement already protects leaving controls, and no consumer requires persistence of view choice across card remount. Acquisition, listed fallback, relisting and stage outcome commands earn their boundary.

Capture unfinished thought and refused text states are retained. A smaller representation collapse remains under focused challenge: timeline excerpt consumes document.source transitively, so deleting fabricated legacy document metadata must preserve exact source preview and identity invalidation. Zhongwen conditional saves/recovery are a different product contract in another repository; no edits there.

Delegated Todo worker owns `/tmp/editor-hunt-todos-20261007`, baseline e155539b3c, prepared dependencies and folder addon. Brief: `/tmp/editor-hunt-todos-brief.txt`. Coordinator baseline: 168 source tests and 13 mounted tests pass. Coordinator integrates only completed work and preserves the existing unrelated TodoStatus edit.

Focused Capture challenge corrected the initial unused-source claim: timeline `excerpt(document)` uses `document.source` when text is unavailable. Invalid rows/frontmatter failures preview whole file; supported frontmatter with refused body previews exact body. Preserving that distinction would introduce another fallback adapter, so the representation collapse is deferred. No Capture edit is justified in this slice.

## Second occurrence set

Files read for this set and its implementation review:

```text
apps/
|-- todos/src/lib/editor.svelte.ts
|-- todos/src/routes/components/FileView.svelte
`-- whispering/
    |-- README.md
    |-- package.json
    `-- src/
        |-- lib/
        |   |-- row-editing.svelte.ts
        |   |-- row-editing.test.ts
        |   |-- row-slot.test-support.ts
        |   |-- settings-draft.svelte.ts
        |   |-- home-controls.test.ts
        |   |-- leave.test.ts
        |   |-- library.test.ts
        |   |-- recipe-playground.test.ts
        |   |-- recording-collection.test.ts
        |   |-- transformations.test.ts
        |   `-- workspace/
        |       |-- desktop-sequences.test.ts
        |       `-- desktop.test.ts
        `-- routes/components/
            |-- FileView.svelte
            |-- RecordingDetail.svelte
            |-- TranscriptCard.svelte
            |-- TransformationDetail.svelte
            |-- file-actions.ts
            `-- row-views.mounted.test.ts
docs/adr/
`-- 0507-editor-views-compose-current-input-and-own-only-interaction-state.md
```


Fresh GPT and Claude Opus read-only reviews examined Whispering transformation/recording/transcript rows, device settings and Todos plain-file editor. Claude session `5519cc65-a177-4014-9e7d-1fd7ea89e03d`; independent and informed challenge turns completed without errors or permission denials. No step editor exists in current Whispering. Both first rejected bypassing held-input policy, then accepted a single guarded complete-row set after explicitly testing the stronger alternative that preserves it.

Whispering row destination: direct current row plus held-input reads, guarded complete `set(next, {control?: {field:string} | 'body'})`, no scalar patch setters. Model/endpoint null values stay null; removing a field means omitting it. Only body-origin conversion restores file newlines. No-control commands preserve body exactly and return admission results. Retain Held/dropRefused/source preference, reload and release rules. Preserve held fields under unrelated writes. Keep body getters normalized to LF to avoid caret resets on CRLF input.

Settings are explicit unsent device configuration, not a row cache. The coordinator reproduced loss of the other connection's unsaved URL after saving transcription: nine old tests pass and new regression fails, receiving stored URL rather than typed URL. Primitive-value derived dependencies fix the reset without another draft; ten tests then pass. Same-connection saved-value changes still follow existing policy. Plain-file conditional saves and conflict reviews are kept; adopting unconditional row replacement would silently overwrite outside edits.

Browser setup used a new Todos tab at port25850. The native browser was concurrently switched back to a personal tab before further interaction, so the coordinator stopped acting on that shared window. No browser persistence or input acceptance is claimed from this setup. Mounted regression acceptance remains separately recorded.

## Accepted completed slices

`c15868881a`: settings overrides depend on configured primitive values, preventing an unchanged connection refresh from discarding typing. Coordinator reproduced the failure before the fix and verified both configured and unconfigured cases afterward: 11 Home controls tests pass, 13 mounted views pass, page/native typechecks pass. This preserves the existing policy that a real change to the same saved connection refreshes URL/model/action; key text typed during Save remains separately protected.

`3325735698`: Todo complete-row API replacement. Worker session `447ecaf3-b17f-4b5c-b2a0-ec08248b7689` completed on Opus5.5, five sandbox command denials recovered without broader access. Worker report saved beside these notes. Coordinator reviewed the completed diff, removed six relocated scalar helpers from TodoDetail and inlined the bindings, merged only row-save access renames into the pre-existing TodoStatus edit, then reproduced 169 source tests, 14 mounted tests, all three typechecks, and browser/host builds. Removed methods/native facade have no remaining references. The unrelated TodoStatus content is identical after undoing only the task's property-name substitutions. Device staging remains byte-identical. A temporary commit index kept concurrently staged API/server work outside this commit.

Worker reports one full-suite git-server assertion fails identically on its baseline and result (expected Add todos/milk.md, received Update2files). Coordinator verification was the affected src suites, not that unrelated server suite; no full-suite success is claimed.

Whispering complete-row migration is delegated separately in `/tmp/editor-hunt-whispering-20261007`, baseline e155539b3c. Brief `/tmp/editor-hunt-whispering-brief.txt`. Source-only mutation API changes must retain held input, Source preference and row publication policy. The coordinator's already-committed settings correction is outside that worker's scope.

## Structural verdict

The destination is `editor.row`, not `editor.route`. For row files, controls read the current accepted fields/body and submit complete replacements. The app's retained owner adds admission and holds only text the native row could not accept. A control origin names where that unsent text belongs; it does not turn the replacement into a patch. The native mutator remains private to prevent bypassing app rules.

Current and proposed file organization are the same: row owners retain operation policy, substantial panels retain their UI, and the bindings live beside controls. No new binding module or forwarding component is justified. The reusable LF conversion already exists in Whispering's file actions. Generic held-field comparison earns its boundary because complete replacements can contain nested metadata; exporting a private folder comparison solely for this consumer would widen the package contract unnecessarily.

Retain separate finite patterns: direct row replacement, codec-composed body replacement, whole-file Source repair, explicit Save forms, conditional plain-file saves, and rich widget interaction state. They share current-value reads without pretending their acceptance promises are identical. Remaining Capture/Vocab acquisition and unfinished-input ownership is not duplicate accepted row data.

Separate reported edge: Whispering currently chooses textarea body newlines from `row.body`. A CRLF-frontmatter file with an empty or single-line body may acquire LF body text. This migration preserves that existing policy; it does not silently change it to a whole-file convention.

ADR-0507 now states the guarded app-owner boundary, private native mutators and refused-input overlay. Its existing Proposed status is preserved.

## Whispering acceptance

`77ba15b64b`: complete-row controls in RecordingDetail, TransformationDetail, TranscriptCard and FileView. Five scalar/display methods are removed, with no aliases. The retained row owner exposes readonly held input, guards complete replacements and keeps the native publisher private. Field omission deletes; body-origin input restores the existing body newline convention; commands preserve the supplied body exactly. New tests cover cross-control refusal, unrelated writes around two held values, omission and actual mounted transcript/transformation controls.

Worker session `68757cce-5ccb-4592-b510-551457f218eb` completed on Opus 5.5 with `is_error: false`. Six tool denials were recovered without expanding access. Completed report is saved beside these notes. The worker changed 16 app files, with no package or settings edits. The complete patch applied cleanly over the coordinator's settings correction.

Coordinator verification after integration:

| Check | Result |
| --- | --- |
| Non-mounted src/lib tests | 379 pass, 24 fail |
| Mounted row views | 15 pass, 0 fail |
| Svelte/page and native typechecks | Pass; 0 errors, 0 warnings |
| Browser UI build | Pass |
| Removed API search and scoped diff check | Pass |

The coordinator inspected the raw worker baseline and result logs: 437/27 at e155539b3c and 439/27 after migration across the broader 25-file suite, with identical failing-name sets. All 24 live src/lib failures are members of that baseline set. Three baseline failures are absent from the narrower live invocation. The failures include definition.json changing file/history expectations and scripted owner replies lacking current protocol operations. No passing claim is made for the desktop sequences or entire suite. No shared protocol or unrelated test is changed to make this editor slice green.

Local post-implementation review retained the app-owned lifetime/admission boundary, substantial panels, held-input comparison and existing LF conversion. Getter/setter wrappers were deleted rather than moved into new production helpers. Test-only composition helpers migrate fixtures; mounted tests verify the actual control bindings. No additional copied row/body state or synchronization effect was introduced.

Device staging remains byte-identical to the task-start capture. Each implementation commit contains only its explicit task files; existing dirty/staged work remains outside this slice. Browser acceptance was attempted but interrupted by concurrent use of the shared native window. Mounted acceptance, native hardware and real provider acceptance remain distinct: this wave establishes the first, not the latter two.

The two occurrence sets are adjudicated. Accepted changes are committed, the guarded-writer clarification is recorded in ADR-0507, and remaining designs are retained for their named information or contracts. No additional cleanup wave is justified by this review.
