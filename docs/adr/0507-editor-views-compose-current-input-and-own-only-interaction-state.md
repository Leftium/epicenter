# 0507. Editor views compose current input and own only interaction state

- **Status:** Proposed
- **Date:** 2026-10-06
- **Updated:** 2026-10-08
- **Relates:** [ADR-0504](0504-row-editors-own-complete-input-and-one-publication-queue.md), accepted row input and publication, and [ADR-0506](0506-capture-composes-values-through-a-source-preserving-body-codec.md), Capture body composition.
- **Unbuilt:** Apply the workspace separation, keyed detail views, repair navigation, and publication handoff to Honeycrisp and remaining consumers that still switch one editor between source and interpreted editing.

## Context

At the start of this decision, Todos selected a folder-relative path and retained either a todo editor or
an arbitrary-file editor, rendering both through one detail area. Its todo
editor kept `rawMode`, exposed `editSource` and `editFields`, and checked the
selected view when accepting writes. Honeycrisp and Capture likewise offered
source and interpreted editing inside one detail workflow.

This combines two questions: which file the person chose, and how the current
editor interprets that file. Invalid input can change the interpretation while
the person types. Preserving view choice across repair and rename adds more
state and admission rules. Reusing a detail component for another editor makes
its bindings follow a changing owner.

The simpler product contract separates navigation by editing purpose. A file
tree opens text. A todo list or table opens structured records. Apps may offer
either workspace or both. Accepted text must survive a failed save regardless
of which workspace or component is visible.

## Decision

**The selection surface determines the editing surface for one editor-view lifetime.**

Apps may place both workspaces in the same detail area. Acquisition follows
the selection entry point and mounts a fresh view for a different editor.

A Files workspace lists files and opens their complete text, including
frontmatter, in a text editor. Parsing as a table row is not required. Missing,
unreadable, or non-text files show an acquisition error or file details rather
than a text editor with invented empty content.

A structured workspace lists editable records, such as todos, notes, or
captures, and opens the corresponding structured controls. A grid is not
required: the product list and its detail editor are one structured workspace.
Invalid files are excluded from its editable records, with a visible repair
entry point naming the affected files and the reason. They remain accessible
through Files. A structured-only app supplies a reachable file repair route,
such as the host's Files workspace or an external editor at the exact path.

```text
Files: file tree -> complete-text editor
Todos: todo list/table -> todo fields and body
Capture: capture list -> text and thoughts
Honeycrisp: note list -> note fields and rich body
```

There is no per-record Source/Fields or Source/Capture toggle. Tabs may select
workspaces or product workflows; they do not change a mounted editor's
interpretation. A rich body widget is a structured representation of the body,
not a full-file Source editor.

**One mounted detail view addresses one acquired editor instance.**

Key the detail by stable editor identity, including when a new editor opens at
the same path. Do not key by the changing row, body, title, or a newly created
wrapper. The detail does not hot-swap its editor prop. Cursor, undo history,
view preference, and unfinished component-local interactions may reset when
that view ends. Unsubmitted forms that the app promises to keep have an
explicit owner above the disposable view.

`{#await}` renders an existing acquisition promise's pending, success, and error
results. It does not guarantee a new component instance for another resolved
editor; use `{#key}` for that boundary. Start acquisition from navigation or
application setup, not from a render expression. Do not duplicate the promise
with `isOpen`, `isOpening`, and `isReady` flags.

The table API acquires row editors; it does not select the current screen.
`folder.tables.<name>.edit(stem)` addresses a table row. App navigation retains
its address while opening or showing an error. A current item can hold that
address and result directly; a separate `selectedPath` plus a derived lookup is
not required. Each workspace owns its selection; the file tree does not retarget a mounted
structured detail. Retaining accepted input is separate from selecting it.

**Controls read current accepted input and submit complete replacements.**

| Surface | Read | Submit |
| --- | --- | --- |
| Files | `editor.row.text`, or the file editor's exact text | `editor.setText(text)`, or the file editor's text setter |
| Structured fields | Valid `editor.row.fields` | `editor.set({ ...editor.row, fields: { ...editor.row.fields, field: input } })` |
| Structured body | Valid `editor.row.body` | `editor.set({ ...editor.row, body: input })` |

These row bindings name the current Folder API. A raw-file editor may expose a
different text API; it need not acquire a table row merely to edit a file.
Textarea projections restore the file's newline convention when submitting.

`set` consumes `fields` and `body`. Spread current fields to preserve unknown
metadata and carry the current body into field replacements. Omitted field
keys are deleted. Read current input at the event, not a render-time snapshot.
A setter does not reject a complete replacement because a different workspace
is selected or because the previous row was invalid. Narrowing a row before
reading its fields is a data-shape requirement, not a tab permission check.

Use decode/encode only when controls represent the body differently, such as
Capture's text and thoughts. The encoded body enters the same complete
replacement. Direct body editing needs no codec or mirrored body draft.

**Invalidity never silently changes a mounted editor's interpretation or destroys accepted input.**

Acquisition of invalid row text can succeed in Folder, but a structured
workspace does not mount structured controls for it. Show the reason and an
explicit repair action. The Files editor stays a text editor when repair makes
its content valid; it does not turn into todo fields automatically.

If an open structured row becomes invalid, retain its editor, exact accepted
text, and save state. Show the problem and repair action in the detail. Controls
that can no longer read their fields become unavailable without rendering fake
empty values or writing a previously captured row. Removing the row from the
valid listing does not close this detail or drop its owner. A body codec or rich
widget can also become unavailable for valid row text; use the same explicit
repair route rather than mounting Source in its place.

A replacement refused before admission restores accepted content and shows a
reason-only notice. It does not create an unsaved-content buffer or block file
operations. Accepted input whose publication fails remains in its editor.
Unsubmitted Add, Send, or explicit Save forms remain genuine temporary input.

**A workspace handoff resolves admitted writes before another editor publishes to that file.**

Open in Files and Open as todo are navigation actions that end one view
lifetime and begin another. They do not reconfigure an editor's address or
interpretation. Retire the outgoing controls and settle the retained owner before
acquiring another publisher. A late command accepted by a raw-file owner must
either be included in that settlement or leave the owner retained and stop the
handoff. This may require asking to open the destination again; it does not
require a second session-admission flag. On failure, keep its owner and input
accessible
with retry, copy, or explicit discard; do not open a fresh editor on stale disk
bytes and pretend the failed input was transferred. After successful settlement
or deliberate discard, retire outgoing app commands and acquire the destination
editor. The native Folder row editor has no disposal method; ending a component
subscription does not cancel its admitted writes.

Within one app, these workspaces do not create independent active publishers
for the same file. An app can retain an editor with failed input while showing
another file. Reopening that file reuses or explicitly resolves its retained
input before a fresh acquisition. This is app ownership, not table selection.
Discarding an unconfirmed save does not cancel or confirm its transport delivery.
Keep that uncertainty visible and follow the existing recovery policy; this
handoff adds no at-most-once delivery guarantee. Independent apps and external
file writers retain their existing conflict policy.

Derive operation admission from the application owner's existing acquisition,
path reservation, recovery, departure, and close facts. Do not copy those facts
into each editor as another fence counter or mode flag. Rename and delete need
a synchronous boundary before draining writes; a later DOM unmount alone is
not that boundary. Native `reload` already preserves newer typing through
`InputChanged`; an app need not disable typing throughout a reload to obtain
that guarantee. This handoff does not add a final-save guarantee to ordinary
close; each app keeps its departure policy.

Shared `Input` and `Textarea` retire destroyed bindings. Other controls and
async callbacks retain their own cleanup rules. Keying prevents a view from
changing owners; it does not revoke callbacks held outside that view.

**Rich widgets retain interaction state without another application document copy.**

ProseMirror and CodeMirror own their live document, selection, and history.
Reconcile against current accepted body content. Different content may create
fresh widget state and reset selection/history. Unsupported content shows the
repair action. Selection-only changes write nothing. A permitted empty
paragraph may have no new Markdown spelling; it needs admission even though
it publishes no changed bytes. Widgets requiring that acknowledgment call the
editor directly because Svelte function bindings discard setter return values.

Matter's table-owned accepted body and Skills' live body node illustrate
accepted-content ownership separate from widget state. Neither should gain a
second mirrored body merely to match Folder's row API.

## Consequences

Files and structured workspaces each have one editing purpose. Mixed
arbitrary-file/todo detail dispatch, Source-mode admission, `rawMode`,
`editSource`/`editFields`, preference transfer across rename, and per-record
Source tabs can be removed as apps migrate. Substantial detail UI can remain a
component; thin bindings need no `BoundText` or `SourceEditor` forwarding layer.

Repair requires navigating to Files or another named file editor. It is no
longer available as an automatic fallback or an in-place Source tab. View-local
cursor, undo, and preference continuity across that navigation is not promised.
Accepted failed input and protected unfinished forms remain owned explicitly.

Apps offering both workspaces need an explicit handoff and one active publisher
per file. Keyed rendering does not replace pending-write accounting or callback
retirement. The migration removes interpretation switching; it does not remove
all file-operation coordination or make concurrent external edits impossible.

## Migration and verification

Migrate one app at a time. First provide the Files repair entry point and keep
its failed-input recovery accessible. Then separate workspace acquisition and
key the structured detail by editor identity. Finally remove the per-record Source tab, view-mode setters, and copied
admission state whose callers
have disappeared. App READMEs describe the implementation that actually ships.

Todos now separates acquisition by selection surface, keys details by editor
identity, and exposes malformed files through a repair section. Its mode flag,
Source tab, view-mode commands, and reload typing fence are removed. A list
checkbox uses the current publisher, including the raw editor when Files holds
the row. See the [Todos README](../../apps/todos/README.md).

Capture now separates Timeline and Files and keys their detail views by its
retained canonical row owner. Both surfaces use that one publisher, so changing
workspaces does not require reacquiring a row or draining a second publisher.
Invalid frontmatter and ambiguous capture bodies expose a repair entry. Files
stays text after repair. Duplicate thoughts are edited by position, and
unsubmitted thought forms remain owned above the disposable detail. See the
[Capture README](../../apps/capture/README.md).

Acceptance exercises opening invalid source through Files, excluding it from
editable structured records with a visible repair route, repairing it without
an automatic view switch, and explicitly reopening it as a record. It also
exercises a row becoming invalid during structured editing, failure followed by
workspace navigation, and delayed old callbacks during a handoff. Accepted
text, unknown fields, file newlines, and unrelated files must survive. Browser
and native publication evidence remain distinct.

## Considered alternatives

- Choosing the editor interpretation from the path or validity inside a shared
  detail pane. It couples file browsing to the product schema instead of
  following the selection entry point.
- Automatic Source fallback for invalid rows, then automatic fields after
  repair. The editor changes purpose while the person types.
- Optional Source/Fields tabs. They retain the dual-mode contract, preference
  state, and inactive-control rules the workspace separation removes.
- Independent source and structured publishers for the same file. An older
  accepted body can replace the other workspace's newer input.
- Keeping only the currently mounted editor. A failed save loses its accepted
  input when the person visits another file.
- Giving tables a selected row or a permanent editor cache. Navigation can
  include non-row files, and failed-input retention is application policy.
- A lazy getter that reparses a fresh rich-editor state on every read. It loses
  selection, history, and intermediate document state even for unchanged body.
