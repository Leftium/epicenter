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
| Structured body | Valid `editor.row.body` | `editor.set({ ...editor.row, body: input })` |

Direct body editing needs no codec. Add decode and encode only when controls
present a different representation of the body, such as Capture's text and
thoughts. The encoded body enters the same complete replacement.

An app-owned editor may guard `set` with operation fences and preserve refused
control input. It still accepts complete replacements. Views compose changes;
the editor decides admission and passes accepted input to the native publisher.
Do not put a body draft or a patch-merging API between those owners.

When the app adds admission rules, expose read-through `row` and `save` and keep
the native mutators inside that owner. A public native editor would let callers
bypass those rules. A control origin identifies where refused input belongs;
it does not select a patch to merge. An unrelated replacement preserves held
input and cannot change that control's accepted value without resolving it.
Views read the held value over the row value until it is repaired or discarded.

Source means the complete file, including frontmatter; body means its text after
frontmatter. Both can use the same textarea or text editor component. The binding
determines what it edits; a separate `SourceEditor` wrapper is unnecessary.

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

The default has one validity branch and no view-selection state:

```svelte
{#if editor.row.status === 'valid'}
  <!-- Fields bind to row.fields; the body editor binds to row.body.
       Setters compose complete replacements from the current editor.row. -->
{:else}
  <Textarea bind:value={
    () => editor.row.text,
    (text) => editor.setText(text)
  } />
{/if}
```

Render structured controls for valid rows and a text editor for invalid rows.
Bind directly to the current editor value; setters submit complete replacements.
When source repair yields a valid row, the structured controls render again.
Derive validity and save presentation from the editor. Do not copy these facts
into `valid`, `saving`, or `shownView` state or synchronize them with effects.
The actual source binding also preserves the file's newline convention.

Keep the reason visible beside invalid source. Body-codec refusal can make a
structured body view unavailable even when the row is valid; that app supplies a
source repair path for the interpretation it cannot edit. A refusal to acquire
readable source is shown as unavailable rather than pretending an editor exists.

Add view selection only when the application needs a person to choose among
views of valid input. Capture offers its interpreted body and the whole file;
Honeycrisp offers rich text and Markdown. Those choices earn Tabs. Tabs are an
extension of the default, not required editor scaffolding.

For that extension, one container owns each view group's selection. Bind to the
existing owner's selection when it must outlive the component, or use one local
`$state`. Do not represent the same choice with separate `tab`, `rawMode`, and
`shownView` values. Invalid input opens Source and disables structured selection.
With explicit selection, repair keeps Source selected until the person chooses a
structured view. This policy belongs to selection, not to row validity.

Shared `Tabs.Content` unmounts inactive children. Callers do not repeat
`tab === 'source'` or `tab === 'capture'` conditions inside each panel. A
structured panel still checks current validity before rendering its controls.
Disabling its trigger does not reset an already selected panel; its selection
owner owns that reset. A workflow panel such as Whispering's Try it remains
available to inspect unfinished results even when structured editing is
unavailable. Use `forceMount` for a named retained lifetime, such as chat input or
rich-editor undo history. Keep refused input and unfinished forms above
otherwise disposable panels.

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

A rich widget owns its live interaction state. For ProseMirror, `EditorView.state`
holds the document being edited, selection, pending marks, and plugin history.
Do not retain another `EditorState` in an application session. Parsing the body
into fresh state on every read loses ordinary typing state even when the body
has not changed.

Inspect the current body before comparing it with the widget document. Supported,
semantically equivalent Markdown keeps the live state, including empty paragraphs
that Markdown does not spell. Different content creates fresh state with the same
plugins; selection and history may reset. Unsupported content exposes Source for
repair. A decode cache may depend on body content, but does not track which view
wrote it.

Before a content-changing transaction, reconcile against the current accepted
body and discard a transaction based on replaced content. Check the encoded body
and submit it successfully before displaying the changed state. Successful
encoding must reopen as supported, equivalent content. Selection and pending-mark
changes write nothing. This admits one widget-state owner without a last-written
body marker or separate synchronization API.

Some permitted document changes encode to unchanged body text: an empty trailing
paragraph is one example. They still require admission before display. Otherwise
an unchanged-text shortcut bypasses a close fence or held Source input. The rich
control receives an explicit acknowledgment without publishing unchanged input.
Ordinary commands can still request publication of the same document, such as
restoring a hand-spelled file into its standard form.

Use function bindings for ordinary controls. A rich widget that must display
only admitted transactions calls the editor directly: Svelte function bindings
discard a setter's return value. Reading the body back cannot distinguish a
permitted empty paragraph from one refused by an operation fence.

Honeycrisp names the submitting control in `set` when that intent matters.
Title and Source retain their own refused text; rich text respects held Source
input without turning a serialization failure into Source's typed value.
Commands preserve held values when changing unrelated fields. A body replacement
composer updates an existing edit timestamp only when the body changes.
Historical restoration composes separately and preserves its historical timestamp.

## Consequences

Apps share a finite set of editing patterns and a visible owner for each rule.
The default needs no selection state. An explicit view choice has one owner.
Tab changes discard disposable controls without losing accepted input or
application-held drafts. Structured setters carry
unknown fields and current body content into their complete replacement.

Unmounting changes panel-local lifetime. A consumer that relies on retained
panel state must keep it above Tabs or explicitly use `forceMount`. Shared text
controls do not replace operation fences, edit-instance checks, or current-row
checks. These protect different information from destruction guards.

## Considered alternatives

- A lazy getter that creates fresh ProseMirror state from Markdown on every
  read. The same content still loses selection, pending marks, and history.
- A rich session that retains another state and the body it last wrote.
  The view already owns interaction state; current-body inspection and semantic
  comparison decide whether to keep it without recording write provenance.
- Mandatory tabs and source preference for every editor. A validity branch
  already chooses the only editable representation; add selection for an actual
  view choice.
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
