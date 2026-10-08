# Input ownership doctrine and source hunt

Date: 2026-10-08. This pass changes guidance, not application behavior.

The two default content-input patterns are:

```text
Immediate editing
control -> current editor.set(complete replacement) -> publication
           accepted-content owner

Explicit submission
control -> unfinished draft -> Submit -> API(captured draft)
           form owner
```

Use one replace-only `$state.raw` object for fields submitted together. A
single-field form may use a scalar. Intentional proxied mutation remains valid;
use `$state.snapshot` when the receiving boundary needs plain data. Neither raw
state nor snapshot freezes an object. A plain replace-only draft needs no copy
unless the receiver's ownership contract requires one.

## Files read before analysis

Some files were read in full; owner and caller sections were read for others.

```text
.agents/skills/
|-- collapse-pass/SKILL.md
|-- agent-instructions/SKILL.md
|-- post-implementation-review/SKILL.md
|-- writing-voice/SKILL.md
`-- svelte/
    |-- SKILL.md
    `-- references/
        |-- component-ui-patterns.md
        |-- mutations-and-workspace-inputs.md
        `-- input-ownership.md
docs/adr/
|-- README.md
`-- 0507-editor-views-compose-current-input-and-own-only-interaction-state.md
apps/
|-- README.md
|-- capture/src/lib/
|   |-- captures.svelte.ts
|   |-- draft.svelte.ts
|   `-- components/{CaptureApp,ThoughtEditForm}.svelte
|-- todos/src/
|   |-- lib/todos.svelte.ts
|   `-- routes/components/{TodoList,TodosView}.svelte
|-- vocab/src/
|   |-- lib/chat/session.svelte.ts
|   `-- routes/components/{ConversationView,PhraseCapture,WordsView}.svelte
|-- whispering/src/
|   |-- lib/{row-editing,settings-draft,library}.svelte.ts
|   `-- routes/components/
|       |-- ConnectionForm.svelte
|       |-- RecordingDetail.svelte
|       `-- TransformationDetail.svelte
|-- skills/src/lib/components/
|   |-- dialogs/NewSkillDialog.svelte
|   |-- editor/SkillMetadataForm.svelte
|   `-- tree/InlineNameInput.svelte
|-- matter/src/lib/{table,open-vaults}.svelte.ts
`-- honeycrisp/node_modules/svelte/types/index.d.ts
```

## Findings

1. **Confirmed older editor model: Whispering row editing.**
   `apps/whispering/src/lib/row-editing.svelte.ts` owns a Source flag,
   automatically selects source for invalid rows, gates structured writes by
   mode, and has a reload counter that blocks input. RecordingDetail and
   TransformationDetail expose the corresponding Source tabs. Migrate this as
   one ownership change: Files edits text, product lists edit structured records,
   and invalid records provide an explicit repair route. Do not remove the gates
   independently of establishing that lifetime and repair path. Keep the real
   transformation Try workflow. This is a known remaining migration, not a new
   defect introduced by this pass.

2. **Candidate requiring a reset decision: Whispering connection form.**
   `settings-draft.svelte.ts` distributes URL, model, key action and typed key
   across writable derived overrides and state, then reconstructs a connection
   change. One raw draft object could make the submission shape clearer. However,
   this owner is shared by several views, refreshes some values from saved
   settings, and implements keep/replace/remove secret behavior tied to the
   endpoint. Decide its reset policy before replacing the model. Preserve shared
   unfinished input, save receipts, and protection against clearing newer typing.

3. **Genuine explicit-submission drafts: keep.**
   Todos' new title, Capture's new capture/thought forms, Vocab's message draft,
   Skills' new-skill name, and InlineNameInput each hold unfinished input until a
   named submission event. One-field forms do not need an object wrapper.
   Vocab's message submission already compares the submitted draft before
   clearing it. PhraseCapture also owns selection and request identities; those
   values are not additional copies of its submitted text. Skills metadata's
   existing blur commit is an explicit submission boundary with DOM-held input.

4. **Accepted-content owner: keep Matter's accepted bodies.**
   `apps/matter/src/lib/table.svelte.ts` owns accepted body values, serialization
   of saves, and failed-save retention. It is the publisher, rather than a
   disposable component mirroring another editor. Removing it would remove the
   information owner the immediate-editing model requires.

5. **Copy boundaries: investigate before deleting.**
   Matter's `open-vaults.svelte.ts` snapshots replace-only raw state before
   persistence. Inspect the storage receiver's retention/mutation contract before
   concluding that detachment is redundant. Whispering's `submitFileChange`
   clones queued arguments; visible callers mostly pass strings, but its generic
   input contract and every caller need tracing before removing the copy. Neither
   match proves a bug or justifies a blanket snapshot/clone removal.

## Search coverage and reuse

The [Svelte input reference](../.agents/skills/svelte/references/input-ownership.md#search-recipes)
contains runnable root-level searches for copied editor values, synchronization
effects, submission events, duplicate payloads, raw mutation, snapshot/clone
boundaries, late resets, and forwarding controls. Follow matches through owners,
rendering, writes and submission before classifying them.

The initial targeted hunt covered Capture, Todos, Honeycrisp, Vocab and
Whispering source. Broader searches across `apps` and UI source led to the Skills
and Matter examples above. There is no `apps/zhongwen/src` in this checkout;
Zhongwen app acceptance is not claimed. Search hits include fixtures, resource
handles and interaction state, so counts would not measure doctrine violations.
No production `$state.frozen` match was found in the searched Svelte sources.
These are heuristics, not an exhaustive ownership proof or an automatic fixer.

## Changes and review

The Svelte skill now routes to one input-ownership reference. Its existing UI
reference and collapse-pass guidance agree with Files/product separation and
explicit repair rather than teaching automatic Source fallback. ADR-0507 records
the two input patterns. The older Y.Map blur guidance is explicitly scoped to
that acceptance boundary instead of being applied to Folder editors.

The common reference earns its file: both Svelte and collapse-pass route to the
same doctrine and search recipes. No new runtime wrapper or state owner was
introduced. Application code, genuine drafts, selection state, queues and rich
history remain unchanged by this pass. The speculative candidates above remain
follow-up work, not silently applied cleanup.

Verification: re-read changed guidance and reviewed its links and whitespace.
Svelte raw/snapshot behavior was checked against installed type declarations.
No application tests or computer-use acceptance were run for this documentation
and read-only source hunt; this pass does not claim runtime migration.
