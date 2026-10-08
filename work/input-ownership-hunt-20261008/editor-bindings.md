# Editor binding hunt: Capture, Todos and Honeycrisp

Read-only source review on 2026-10-08. No application files changed and no app
acceptance checks ran. Source locations describe this checkout, including its
existing uncommitted workspace work. The two input patterns are recorded in
`.agents/skills/svelte/references/input-ownership.md`.

## Files read

Files below were read in full or at the relevant ownership/caller/test sections.
Search-only matches are excluded.

```text
.agents/skills/
|-- collapse-pass/SKILL.md
`-- svelte/references/input-ownership.md
apps/
|-- README.md
|-- capture/
|   |-- README.md
|   `-- src/lib/
|       |-- draft.svelte.ts
|       `-- components/
|           |-- CaptureDetail.svelte
|           `-- ThoughtEditForm.svelte
|-- todos/
|   |-- README.md
|   `-- src/
|       |-- lib/
|       |   |-- editor.svelte.ts
|       |   |-- todo-editor.svelte.ts
|       |   `-- todos.svelte.ts
|       `-- routes/components/
|           |-- FileBrowser.svelte
|           |-- FileNameBar.svelte
|           |-- TodoDetail.svelte
|           |-- TodoDetail.mounted.test.ts
|           `-- TodoList.svelte
`-- honeycrisp/
    |-- AGENTS.md
    |-- README.md
    `-- src/
        |-- lib/
        |   |-- editor/rich-text.ts
        |   |-- file-session.svelte.ts
        |   |-- notes.svelte.ts
        |   |-- notes.folder.test.ts
        |   `-- workspaces.test.ts
        `-- routes/components/
            |-- FileBrowser.svelte
            |-- FileNameBar.svelte
            |-- FileView.svelte
            |-- FolderNav.svelte
            |-- NoteDetail.svelte
            |-- NoteDetail.dom.test.ts
            `-- RichEditor.svelte
packages/ui/src/textarea/textarea.svelte
```

## Grounded change: retain a folder-name submission until its outcome

`apps/honeycrisp/src/routes/components/FolderNav.svelte:38` captures `naming`,
then clears it before validation or awaiting either API. A refused create or
rename leaves only a toast and loses the unfinished name. The API does return
failure: `notes.svelte.ts:1592` can refuse closing or a previous unconfirmed
creation. The owner retains unconfirmed operation records; that receipt is not
the same information as an unfinished form draft.

The same handler chooses create versus rename by whether a target happens to
remain listed. If a selected rename target disappears before Enter/blur,
`target === undefined` calls `createFolder(name)`. Submission intent should come
from the draft, not the current list lookup. A missing rename target should
remain a failed rename, with its name kept.

Current shape:

```ts
const submitted = naming;
naming = undefined;
const target = folders.find(folder => folder.path === submitted?.path);
const problem = target ? await rename(target) : await create();
```

Proposed ownership sketch, with replace-only updates giving every changed input
a distinct draft object:

```ts
let naming = $state.raw<NameDraft | undefined>();
let submitting = $state(false);

// The input setter replaces naming rather than mutating naming.value.
naming = { ...naming, value };

async function commitName() {
  if (!naming || submitting) return;
  const submitted = naming;
  const name = submitted.value.trim();
  if (!name) return; // Explicit Cancel remains the discard action.
  submitting = true;
  try {
    const problem = submitted.path === undefined
      ? await notes.createFolder(name)
      : await renameExistingFolder(submitted.path, name);
    if (problem) present(problem);
    else if (naming === submitted) naming = undefined;
  } finally {
    submitting = false;
  }
}
```

This is a sketch, not a proposed new helper API. Inline the rename lookup in the
actual handler. Keep an absent target explicit. Keep the folder owner's unknown
outcome records and duplicate-admission rules; do not retry uncertain creates
automatically. Suppressing concurrent Enter and blur submissions becomes
necessary once the draft is retained during the request.

Deletion prize: remove the preemptive discard and list-presence-based intent
inference. No reduction in rune count is promised. Retained information: exact
unfinished name, selected action/path, operation receipt and newer input.

Focused verification: mounted FolderNav test with delayed success and failure;
Enter followed by blur submits once; refusal keeps the value; newer typing and a
new naming instance survive an older success; disappearing rename target never
creates a replacement folder. Exercise those paths through the UI after a fix.
Existing `notes.folder.test.ts:2530` covers an unconfirmed folder creation in the
owner, but does not verify FolderNav's unfinished input. No direct FolderNav
mounted tests were found by the scoped search.

## Grounded change: bind file-manager submission to the actual draft

Both `apps/todos/src/routes/components/FileBrowser.svelte:145` and
`apps/honeycrisp/src/routes/components/FileBrowser.svelte:145` capture the current
`editing` object, await an operation, then unconditionally clear `editing` on
success. Their fields remain enabled and Escape/new-action controls remain live.
An older completion can therefore remove a newer naming form. It also focuses
the old target afterward, and Todos may call `onOpen` for that old operation.

There are two distinct cases:

1. A new naming instance replaced the old one. `editing === submitted` protects
   it.
2. The person typed a newer name into the same instance while the request ran.
   Its value currently lives in the DOM, not `editing`, so that identity check
   alone cannot protect the newer text.

A coherent correction is one replace-only draft containing the action, target
and value. Initialize its name once, bind the input to that draft, replace on
typing, and capture it at submission. Clear and navigate/focus after success
only while that exact draft is still current. Keep the in-flight operation guard
separate. Check currentness again after `tick()` before shifting focus.

```ts
const submitted = editing; // Includes value, kind and target.
const problem = await applyName(submitted);
if (problem) return present(problem);
if (editing !== submitted) return;
editing = undefined;
// Navigation/focus also needs to respect any newer form opened afterward.
```

Alternatively make pending state observable and disable the actual submitted
field for the request, while preserving deliberate Cancel/new-form behavior.
Do not claim a bare identity check covers DOM-held newer text. The first option
matches the saved replace-only draft doctrine and removes the separate DOM-value
submission protocol, at the cost of owning the unfinished scalar in the form.

Focused verification: delay a create/rename; type a different name before the
reply; cancel and start another action before the reply; assert the new value
and form survive and focus is not stolen. Check failure keeps the value and
Enter/blur does not duplicate requests. Preserve existing API-level rename
tracking and uncertainty handling. The mounted Todos suite uses FileNameBar,
not a dedicated FileBrowser race fixture; this candidate needs focused UI
coverage if implemented.

Whispering's file browser is a possible sibling for the same search. It was
outside this agent's scope and is being checked independently; no finding about
that consumer is claimed here.

## Small grounded collapse: use Honeycrisp's shared value binding

`apps/honeycrisp/src/routes/components/FileView.svelte:131` uses separate
`value` and `oninput` to send text to its retained file session. Todos and Capture
already use shared function bindings for equivalent complete-text input.
The shared Textarea retires binding reads and writes on destruction.

```svelte
<Textarea bind:value={
  () => session.buffer.replace(/\r\n?/g, '\n'),
  (text) => session.input(withFileNewlines(text, session.buffer))
} />
```

Deletion prize: the native event/value forwarding path and its extra mounted
check for this field. Keep `mounted` where it guards other native commands;
do not delete the view's whole lifetime guard. Keep the file session, which owns
accepted text and conditional saves; this is not a second component draft.
`file-session.svelte.ts:725` refuses input only after disposal.

Focused verification: extend/run the existing CRLF and detached Files-control
case in `NoteDetail.dom.test.ts:250`, then type in Files, change workspace and
deliver an event to the old control. Accepted text, publication policy and file
newlines must stay unchanged.

## Keep or defer

- Capture's text getter/inputText and `setCapture` transform a body codec,
  present refusal, preserve newline policy and invoke the only publisher.
  They are not empty forwarding wrappers. Its explicit Add/Save thought forms
  own real unsubmitted input and guard changed-list/edit identities.
- Todos and Honeycrisp structured controls compose the current row. The
  remaining status checks in callbacks narrow a union at event time; they are
  not extra Source permissions. Empty fallback getters are awkward, but
  deleting them mechanically does not type-narrow a future callback. No new
  state owner or greenfield typed API is justified merely to remove a ternary.
- Honeycrisp's ProseMirror view and active toolbar state carry selection,
  history, stored marks and transaction notification. The body-following effect
  handles reload/history changes. Removing those would discard real widget
  information, not collapse a mirrored Markdown draft.
- Honeycrisp FileNameBar and Todos FileNameBar have a legitimate single-field
  submission value. Their writable `$derived(name)` does reset a typed override
  when name changes. A once-initialized `$state(untrack(() => name))` would require
  an explicit rename-success and external-name refresh policy; classify this as
  a reset-policy decision rather than an automatic conversion.
- Raw file `buffer` plus saved baseline in Todos and Honeycrisp belongs to
  the accepted-content publisher and conditional-save contract. Preserve it.
  This is distinct from the app row-editor controls, which hold no mirrored
  current body.

The strongest new work is fixing finite submission ownership in name forms.
The broad rich/editor-content hunt did not find another convincing mirrored
component body to delete in these three apps.
