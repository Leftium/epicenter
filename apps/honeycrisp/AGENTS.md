# Honeycrisp App

File-authoritative Markdown notes. Read [the README](README.md) for how the
app, the folder host, and the desktop shell fit together, and verify it
against the code. The constraints below apply to every edit here.

## The files are the data

- The notes directory's current files are the saved data, and `<root>/.git`
  is ordinary Git. Do not add a second store beside them: no IndexedDB copy
  on the desktop, no mirrored checkout, no import step, no cache that can
  disagree with a file.
- Do not add Yjs, a CRDT, an account, or sync to this app. Nothing in
  `src/`, `host/`, or `src-tauri/` may import `@y/*`, `yjs`, `@epicenter/auth`,
  or `@epicenter/sync`. `src/lib/platform-selection.test.ts` checks the
  bundles. The `smoke/account-popover` fixture belongs to `packages/auth`'s
  smoke test; it is why `@epicenter/auth` and `@epicenter/app-shell` remain
  dev dependencies, and it is not part of this app.
- Do not add a migration, a legacy reader, or a compatibility path for the
  earlier Yjs-backed Honeycrisp. There are no users to carry forward.
- Opening or listing a note must not write its file. Only an edit writes.
- Change a note's text through `src/lib/note-source.ts` and the folder's
  table operations, which patch source in place. Do not re-emit frontmatter:
  unknown keys, comments, quoting, and key order belong to the person.

## One draft, never two

- A note has one draft: `Draft.buffer`, the whole source text. The rich-text
  view and the Source view are both views of it. Do not give either view
  state the draft does not hold.
- Every ProseMirror transaction that changes the document goes through
  `RichSession.apply`, which checks it before it is displayed and writes it
  to the draft in the same step. Do not call `view.updateState` with a
  document the session did not return.
- Do not weaken `checkNoteDoc` to let an edit through. If Markdown cannot
  spell it, the edit is refused. If it should be spellable, fix the
  serializer and add the case to `markdown.test.ts`; the property tests in
  `markdown.fuzz.test.ts` must keep passing with zero refusals for typing
  and for whole-word formatting.
- Adding a node or mark to `editor/schema.ts` requires its Markdown in both
  directions and tests for both. Source the schema cannot hold is refused by
  `inspectNoteBody`, not dropped.
- The rich-text view's lifetime depends on one boolean (`editable`) and its
  element. Do not make its mount effect read anything that changes on a
  keystroke; that recreates the view and erases undo history.
- A draft is never discarded by an observation, a failed save, a refused
  save, a rename, a delete, or a selection change. Only an explicit choice
  by the person discards one.
- Every native close needs the mounted page's acknowledgment. A reported
  draft count, a disconnected event stream, or a stopped file process never
  approves discarding work in the window.
- Keep `accepted`, `buffer`, `inFlight`, and `external` separate in
  `draft.svelte.ts`. A save acknowledges only the text it captured.

## The boundary

- The page reaches its folder only through `#platform/notes-host`. Do not
  detect the platform at runtime, and do not import a native or Node module
  under `src/`.
- The desktop page calls no Tauri command. It talks to the folder host over
  the same-origin `/bridge`. Keep the token out of the served page except in
  the documented standalone mode.
- `/bridge/call` accepts only the paths in `FOLDER_METHODS`. Adding a folder
  method there is a contract change: update the README table and the host
  tests together. App-specific operations go on `/bridge/app`.
- Do not describe the native conditional save as atomic. It compares, then
  replaces; another program can write in between.
- Fault injection stays behind `HONEYCRISP_FAULTS=1` and an explicit
  `HONEYCRISP_ROOT`. It must never be reachable for the default directory.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save wait for a commit.

## Words a person reads

Say note, folder, file, draft, saved, and commit. Do not put `entry`,
`buffer`, `bridge`, `host`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
