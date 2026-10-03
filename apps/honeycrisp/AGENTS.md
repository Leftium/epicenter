# Honeycrisp App

File-authoritative Markdown notes. Read [the README](README.md) for how the
page, the desktop shell, and the folder plugin fit together, and verify it
against the code. The constraints below apply to every edit here.

## The files are the data

- The notes directory's current files are the saved data, and `<root>/.git`
  is ordinary Git. Do not add a second store beside them: no browser-storage copy
  on the desktop, no mirrored checkout, no import step, no cache that can
  disagree with a file.
- Do not add Yjs, a CRDT, an account, or sync to this app. Nothing in
  `src/` or `src-tauri/` may import `@y/*`, `yjs`, `@epicenter/auth`, or
  `@epicenter/sync`. `src/lib/platform-selection.test.ts` checks the
  bundles. The `smoke/account-popover` fixture belongs to `packages/auth`'s
  smoke test; it is why `@epicenter/auth` and `@epicenter/app-shell` remain
  dev dependencies, and it is not part of this app.
- Do not add a migration, a legacy reader, or a compatibility path for the
  earlier Yjs-backed Honeycrisp. There are no users to carry forward.
- Opening or listing a note must not write its file. Only an edit writes.
- Opening an initialized folder changes no saved file, commit, or ref,
  even when its repository has no commit yet. Only missing layout/defaults
  are initialized. Do not request a commit because a folder has no head.
- The shell writes nothing inside the notes directory. A missing layout is
  created by the page through the attached folder, after the owner holds the
  lock, in `src/lib/platform/first-open.ts`: look first, write `kv.json`
  only when a read confirmed it absent and only if it is still absent, and
  never retry an outcome that is unknown. Table directories come from the
  declaration; do not list them a second time in Rust.
- Structured rows use `folder.tables.<name>.edit(stem)`. Retain one editor
  per open row and share it across rich-body, body-text and metadata controls.
  Do not add another app-owned save or observation engine for those rows.
- A structured save writes the complete canonical document through `overwrite`.
  Unknown metadata values remain; YAML comments, quoting and prior key order
  are rewritten. Opening and listing do not rewrite a file.
- Unsupported or invalid source uses a separate raw repair workflow. Raw file
  access must remain available even when a table editor cannot open the file.
- A file whose text does not parse stays listed and opens for source repair.
  Show a draft's diagnostics from its current text, never from the saved file.
- An action checks the fields it needs, not whether the whole entry is free
  of issues. A destructive action that must find every related file refuses
  when any file's relation did not validate (`deleteFolder`).

## Editor ownership

- The folder editor owns a structured row's document, comparison baseline,
  admitted save, observation and subscription lifetime. The app owns selection,
  retained editors, autosave timing and close fencing. Views share the retained
  editor; they do not start separate autosave timers or reopen it on keystrokes.
- A save receipt acknowledges submitted bytes. A later read is a separate
  observation and never proves which request published those bytes.
- Unknown replies remain unknown in save history. Do not force the editor to
  retain and reissue only the old attempt, clear uncertainty from matching text,
  or prevent explicit adoption or discard under the editor's rules.
- Autosave pauses after failed or unknown outcomes. Resume is app policy and
  must not replay a provider request or an old file command on its own.
- Arbitrary text files and source repair remain raw file workflows. Do not
  invent a table schema for them or introduce a second current-content store.
- Rename and delete use a reviewed file capture. Inspect both paths after an
  interrupted or unknown move before a renewed destructive action. A generic
  batch journal or permanent path-change lock is not required.
- Register admitted file actions before awaiting them and check the input fence
  at admission. Close counts drafts, admitted work and unknown workflow outcomes
  separately. A failed or unknown reply is not proof that nothing was saved.
- Every ProseMirror transaction that changes the document goes through
  `RichSession.apply`, which checks it before it is displayed and writes its body
  to the shared editor in the same step. Do not call `view.updateState` with a
  document the session did not return.
- Do not weaken `checkNoteDoc` to let an edit through. If Markdown cannot
  spell it, the edit is refused. If it should be spellable, fix the
  serializer and add the case to `markdown.test.ts`; the property tests in
  `markdown.fuzz.test.ts` must keep passing with zero refusals for typing
  and for whole-word formatting.
- Adding a node or mark to `editor/schema.ts` requires its Markdown in both
  directions and tests for both. Source the schema cannot hold is refused by
  `inspectNoteBody`, not dropped.
- A view shows only input the editor accepted. If the shared editor refuses a
  change, `RichSession.apply` refuses that transaction too.
- The rich-text view's lifetime depends on one boolean (`editable`) and its
  element. Do not make its mount effect read anything that changes on a
  keystroke; that recreates the view and erases undo history.
- A draft is never discarded by an observation, a failed save, a refused
  save, a rename, a delete, or a selection change. Only an explicit choice
  by the person discards one.

## Closing

- Once the page holds its folder, every native close needs that page's
  answer to that request. Nothing else approves one: not a draft count, not
  a timeout, not a page that stopped answering, not the shell itself. Do not
  add a native prompt that discards on the page's behalf.
- The page registers with the shell before it opens the folder, listens
  before it says the folder is open, and says so before the notes exist.
  `openGuarded` in `src/lib/platform/shell.tauri.ts` keeps that order; do not
  open the desktop folder around it.
- An approval names its page generation and its request. Keep both checks in
  `src-tauri/src/close.rs`, and keep **Keep editing** an explicit decline.
- Input is fenced before drafts are counted and stays fenced while the
  approval is on its way. `notes.fenceInput()` is the one switch: sessions
  refuse input and choices, notes actions and the terminal refuse to run,
  and `NotesView` is `inert`. A new way to change a file must check it, and
  a control in a menu, popover, or dialog must also be `disabled`, because
  those render outside the inert root. Do not unmount the editors to fence
  them: that loses undo history.
- Release the fence only for **Keep editing** and for the two gate refusals
  listed in `APPROVAL_NOT_TAKEN` in `shell.tauri.ts`. Those are the texts of
  `Refusal::StalePage` and `Refusal::NoSuchRequest` in `close.rs`; change
  them together. "the app is already closing", any other text, and any other
  failure keep the fence.
- Route every way out through the gate: the window's close request, the run
  loop's exit request, and the macOS Quit menu item, which stays custom
  because the predefined one cannot be prevented.

## The boundary

- The page reaches its folder only through `#platform/notes-host`. Do not
  detect the platform at runtime, and do not import a Node or Bun module
  under `src/`.
- The desktop folder is the shell's: the page opens it with `openFolder`
  from `@epicenter/folder/tauri` and names its ID only. Shared code imports
  the folder contract from the bare `@epicenter/folder`, which each build
  aliases to its one adapter entry in `vite.config.ts`; keep
  `scripts/module-graph.ts` doing the same. Do not add another folder
  engine, a Git implementation, or a history scheduler to the desktop page,
  and do not fall back to browser storage when attaching fails.
- The root, the commit author, and the window allowed to use them are decided
  in `src-tauri`. No command accepts a root or a working directory from the
  page.
- History stays in the directory. Register the folder with no remote, and do
  not enable `use_repository_origin`. Use `use_repository_author` to read
  identity under the owner lock.
- The notes window loads the bundled page's exact origin only. Keep the port
  and credentials checks in `is_app_page`.
- A shell command exists in three places that change together:
  `src-tauri/src/command_names.rs`, the handler list in `lib.rs`, and
  `src-tauri/capabilities/main.json`. `src-tauri/src/tests.rs` checks them
  against each other. Update the README's command table with them.
- The desktop terminal is the shell's own `/bin/sh`, an outside writer. Do
  not replace it with `folder.terminal()`, which is the browser leaf's
  emulated shell; do not route it through the folder's publication, and do
  not make it request a commit.
- A path from the page is checked with the folder owner's `path_problem`
  before `git` sees it, and a commit must be a hexadecimal id. Keep both
  checks in `history.rs`.
- Do not describe the native conditional save as atomic. It compares, then
  replaces; another program can write in between.
- Do not add fault injection to the shell or wrap the folder's writes to
  simulate failures. The README lists how to produce a real failure in a
  disposable directory; never test against the default one.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save wait for a commit.
- `bun run test` must not need Rust. Tests that need the shell live in
  `src-tauri` and `native-tests/` and run with `bun run test:native`.

## Words a person reads

Say note, folder, file, draft, saved, and commit. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
