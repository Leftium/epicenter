# 0507. Editor views compose current input and own only interaction state

- **Status:** Proposed
- **Date:** 2026-10-06
- **Relates:** [ADR-0504](0504-row-editors-own-complete-input-and-one-publication-queue.md), row input and publication, and [ADR-0506](0506-capture-composes-values-through-a-source-preserving-body-codec.md), Capture body composition.

## Context

A source view and a structured view edit the same open file. Copying the editor's
row, validity, save status, or body into component state introduces another owner
and synchronization work. Separate tab selection and source-mode flags can also
express the same choice twice. Thin editor components and paired getter/setter
props add navigation without owning an editing rule.

Two temporal boundaries remain real: the row can change before Svelte removes a
control, and a detached DOM element can still deliver its native binding event.
Removing redundant state must preserve input across both boundaries.

## Decision

One editor owns accepted input and its publication queue. Views read through the
editor's reactive facade and compose complete replacements from its current row.
The application retains input the editor has not accepted and owns unfinished
editing sessions, confirmations, and operation fences.

There are three common binding patterns:

| Pattern | Read | Submit |
| --- | --- | --- |
| Source | `editor.row.text` | `editor.setText(text)` |
| Structured fields | Valid `editor.row.fields` | `editor.set({ ...editor.row, fields: { ...editor.row.fields, field: input } })` |
| Structured body | Valid `editor.row.body`, interpreted by a codec | `editor.set({ ...editor.row, body: encodedBody })` |

`set` consumes only `fields` and `body`; spreading a valid row intentionally
preserves the other part. Spread nested fields to preserve unknown metadata.
Omitted field keys are deleted. Read current input at the event, rather than
submitting a snapshot captured when the view mounted. An explicit Save form may
instead own and submit a deliberate complete draft.

Row validity and saving are independent. The row has `valid` and `invalid`
variants; both contain current source. Saving has `idle`, `saving`, and `failed`
variants. Acquisition and release belong to application lifetime, not a third row
state. Invalid input may be saved for repair; save failure preserves accepted
input. Body-codec refusal is separate from row validity.

A container owns one selection per editor view group. Use the existing owner's
selection when it must outlive the component, or one local `$state` for Tabs.
Derive eligibility and save presentation from the editor. Do not maintain
additional `valid`, `saving`, `rawMode`, or `shownView` state for the same facts.
This is a limit on duplicated selection state, not on real interaction state.

Invalid input makes structured selection unavailable and opens Source for repair.
Repair leaves Source selected until the person chooses a structured view. Keep
the reason visible in Source. A body codec may also make a structured view
unavailable; source remains accessible. A refusal to acquire readable source is
shown as unavailable rather than pretending there is an editable row.

Shared `Tabs.Content` owns inactive panel unmounting. Callers do not repeat
`tab === 'source'` or `tab === 'capture'` conditions inside each panel. A
structured panel still checks current validity before rendering its controls.
A workflow panel such as Whispering’s Try it may remain available to inspect
unfinished results even when structured editing is unavailable. Disabling a
structured trigger does not reset an already selected panel; the container or
selection owner owns that reset. `forceMount` explicitly retains a hidden panel
when a named lifetime, such as a chat draft or rich-editor undo history, requires
it. Refused input and unfinished forms belong above disposable panels.

Shared `Textarea` and `Input` own their component lifetimes. Once destroyed, their
value bindings neither read the application owner nor submit input. This removes
app-local `BoundText`, `LiveTextarea`, and `LiveInput` wrappers. Other event
handlers and controls retain their own lifetime rules. A leaving control can
remain alive before removal, so a structured setter still checks current row
validity and application eligibility at the event.

Keep simple bindings beside controls and inline components that only forward an
editor or a value. Keep a boundary that owns substantial UI, a codec, a resource
lifetime, or an editing session. A typed valid-row prop can make a getter total;
its setter still composes from the current owner rather than that render snapshot.

## Consequences

Apps share a finite set of editing patterns and a visible owner for each rule.
View selection has one owner. Tab changes discard disposable controls without
losing accepted input or application-held drafts. Structured setters carry
unknown fields and current body content into their complete replacement.

Unmounting changes panel-local lifetime. A consumer that relies on retained
panel state must keep it above Tabs or explicitly use `forceMount`. Shared text
controls do not replace operation fences, edit-instance checks, or current-row
checks. These protect different information from destruction guards.

## Considered alternatives

- A copied reactive row with synchronization effects. The native editor already
  owns current input and announces changes; copying creates competing owners.
- Hidden panels everywhere. Controls remain alive and every caller must implement
  inactive-view gating, even when the panel has no state worth retaining.
- A source component that forwards one textarea binding. Inline the binding;
  keep a component only when it owns another contract.
- Removing all guards because a structured component rendered under a valid-row
  condition. Rendering eligibility cannot prove that a later event has valid
  input or that a destroyed control may write again.
- A blanket limit of one `$state` in an entire editor. Refused text, unfinished
  thought forms, confirmation reviews, and operation fences need real ownership.
