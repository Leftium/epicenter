# Shared bindings own text control lifetime

Starting HEAD: 7d94363cb1. Only the three Honeycrisp paths below were edited, all
clean at task start. Existing device staging and other dirty work were preserved.

## Files read

```text
apps/
|-- capture/src/lib/draft.svelte.ts
|-- todos/
|   |-- README.md
|   |-- package.json
|   `-- src/
|       |-- lib/todo-editor.svelte.ts
|       `-- routes/components/TodoDetail.svelte
`-- honeycrisp/
    |-- AGENTS.md
    |-- README.md
    |-- package.json
    `-- src/
        |-- lib/note-editor.svelte.ts
        |-- lib/note-source.ts
        `-- routes/components/
            |-- NoteDetail.svelte
            |-- NoteDetail.dom.test.ts
            `-- Lifetime.svelte
packages/ui/src/
|-- input/input.svelte
`-- textarea/textarea.svelte
```

## Finding and resolution

Honeycrisp duplicated the shared text controls' destroyed-binding guards in three
app setters. The structured tabs also carried a Lifetime wrapper used only by
the Source textarea. Shared Input/Textarea already guard reads and writes using
onDestroy, so those guards and that wrapper add no protection. The finding was
announced before editing. Removed them and updated the local instructions and
Lifetime comment to name the real owner.

Native select handlers and command buttons still need their block Lifetime. The
retained rich editor, forceMount, current-row checks, timestamp composition, file
newline handling, rejected input and operation fences stay intact. No new
wrapper, state, API, storage behavior or refusal policy was introduced. Todos
already had this division, and Capture's pending text and thought editing are
real unsent input, not duplicated accepted-row state.

## Verification and final review

Re-read every changed file against its callers. The tab group still has the
same conditional mount and rich forceMount; removing its parent wrapper adds no
new lifecycle. The remaining local live() check in NoteDetail protects the native
folder select. Text value setters read the current editor at the input event.

- Honeycrisp DOM suite: 19 pass before and after, including detached title,
  Source and file controls; old controls after a view returns; failed saves;
  refused input; rich undo/history; and reload behavior. No new tests needed.
- Browser and Tauri Svelte checks: no errors or warnings; scripts TypeScript
  check passed. Production browser build: exit 0.
- Browser acceptance through computer use: fresh Chrome Guest origin
  http://localhost:25852, disposable notes/992210aa14.md. Title Shared binding
  lifetime saved. Source body appeared in rich text. Rich typing appeared in
  Source, and Undo removed it after a Source round trip. Edit as file saved
  Whole file still edits, and Open as note showed it in rich text. No native
  shell/hardware or provider acceptance is claimed.
- Scoped whitespace checks passed. Device index patch compared byte-identical
  to the task-start capture.

Logs: /tmp/editor-stragglers-honey-{baseline,after,types,build}.log. The task-owned
dev server is on port 25852. Other browser tabs and user data were left alone.
