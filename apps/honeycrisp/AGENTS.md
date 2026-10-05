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
- An open note uses one row editor from `folder.tables.notes.edit(stem)`,
  retained per path above the views. Its title, folder, pin, rich-text,
  Source, and file view all go through it. Do not add another save or
  observation engine for notes, a second publisher for their raw text, or a
  temporary editor for a one-off change.
- A structured edit gives the editor the complete document at once, every
  field it has (unknown ones included) and the body, through `set`; a key
  left out is removed. The file view gives it its exact text through
  `setText`. Every write replaces the existing file and never creates one: a
  note deleted elsewhere is written again only by the person's explicit,
  exclusive create. Opening and listing do not rewrite a file.
- A field command on a row with no open editor (pin, trash, restore, folder
  assignment, folder name) uses `folder.tables.<name>.update`, which keeps
  every other byte and publishes even when the values already match. Pass
  `{}` when the value stands on its own and `{ expectedSha256 }` when it was
  derived from a listed snapshot; keep that condition in the pending record
  so a resend is never rebased. On an open note the same command goes into
  its editor as the whole note. It is refused, before it changes the editor,
  while the last save failed or is unconfirmed, the note shows its file or
  has fields that do not read, or a rename or delete runs or stopped short:
  going past one would act as the person's Try again. A running save is no
  reason to refuse; the write queues behind it.
- A note whose text does not read as one opens the same row editor and is
  repaired in its file view. Never hand a note path to a text session or an
  ordinary file publisher, including when its editor does not open; a file
  with no text to edit shows why.
- A file whose text does not parse stays listed and opens for repair. Show an
  open note's diagnostics from the editor's text, never from the saved file.
- An action checks the fields it needs, not whether the whole entry is free
  of issues. A destructive action that must find every related file refuses
  when any file's relation did not validate (`deleteFolder`).

## Editor ownership

- The row editor owns the note's one input and the one queue that
  publishes it. Every accepted edit goes to it at once; there is no app
  draft, baseline, submission timer, or copy of submitted text beside it.
  The note session (`note-session.svelte.ts`) owns only the raw or fields
  view, input admission and fences, the rename or delete being tracked, and
  release. Views read the editor through `fromRowEditor`; do not copy its
  row, diagnostics, or save state into app state.
- The editor never reads the file by itself, and the app never adopts
  another program's text into an open note. Only the person's **Reload
  file** (`reload`) does, with input fenced while it reads; warn first when
  text is not saved. A reload that fails, or that input overtook, changes
  nothing: the text and its save state stay. `notes.refresh` refreshes
  listings and text-file sessions, not open notes. A note save replaces the
  file: the last writer wins.
- A save receipt acknowledges submitted bytes. A later read is a separate
  observation and never proves which request published those bytes.
- A failed or unconfirmed write pauses publication until the person chooses
  Try again (`retry`), however much they type meanwhile; the text stays
  editable. Present unconfirmed as uncertainty, with the folder's own
  message. Nothing replays an old request, and `flush` only waits.
- Typed text the editor refuses (a title or Markdown source with an
  unpaired surrogate) stays in its own control with the reason shown, and
  counts as unsaved. It is never submitted and never grows into a whole
  draft. Nothing releases the session while such text waits: a release
  would erase it.
- Arbitrary text files remain raw file workflows over their exact text. Do
  not invent a table schema for them or introduce a second current-content
  store. Note repair is not one of them.
- Rename and delete fence the note's input, wait for every admitted write
  (`flush`), then capture the file; they refuse after a failed save and
  when the file is not the text the editor holds. Delete removes exactly the
  capture the person confirmed and reads nothing after the confirmation.
  While a rename or delete is unconfirmed, stopped short, or no longer
  tracked, the note takes no typing, since every edit publishes at its old
  path. Inspect both paths after an interrupted or unknown move before a
  renewed destructive action. A generic batch journal or permanent
  path-change lock is not required.
- Register admitted file actions before awaiting them and check the input fence
  at admission. Close counts unsaved text, admitted work and unknown workflow
  outcomes separately. A failed or unknown reply is not proof that nothing was
  saved.
- A view reused across sessions reads its `session` prop when each getter,
  setter, and handler runs; do not bind to method references taken when it
  mounted. Svelte keeps binding listeners on detached elements, so every
  setter and command checks the lifetime of its own control's block
  (`Lifetime.svelte`), not the whole view's: a control from a block that
  is gone takes nothing, even after the same kind of block mounts again. A
  destroyed rich-text view takes no transaction, and a released session
  refuses everything for good. Do not key or remount a view per input to get
  around any of this; that loses focus and undo.
- A save never creates a note file. After a save or reload found no file,
  saving the editor's exact text as a file is a separate exclusive create,
  at the note's own path when it is free, else as a new note; a file found
  at either path stays as it is. Refuse text a file cannot hold exactly (an
  unpaired surrogate) rather than let encoding replace it, and refuse while
  refused typed text waits in a field. Never try another
  path after a create whose reply was lost. Keep the exact text on screen
  until an editor opens over the new file, or the person dismisses it.
- Every ProseMirror transaction that changes the document goes through
  `RichSession.apply`, which checks it before it is displayed and gives its
  body to the note's editor in the same step. Do not call `view.updateState`
  with a document the session did not return.
- Do not weaken `checkNoteDoc` to let an edit through. If Markdown cannot
  spell it, the edit is refused. If it should be spellable, fix the
  serializer and add the case to `markdown.test.ts`; the property tests in
  `markdown.fuzz.test.ts` must keep passing with zero refusals for typing
  and for whole-word formatting.
- Adding a node or mark to `editor/schema.ts` requires its Markdown in both
  directions and tests for both. Source the schema cannot hold is refused by
  `inspectNoteBody`, not dropped.
- A view shows only input the note's editor accepted, apart from refused
  typed text kept in its own control. If the editor refuses a change,
  `RichSession.apply` refuses that transaction too.
- The rich-text view's lifetime depends on one boolean (`editable`) and its
  element. Do not make its mount effect read anything that changes on a
  keystroke; that recreates the view and erases undo history.
- An open note's text is never replaced by an observation, a failed save, a
  refused save, a rename, a delete, or a selection change. Only the person's
  reload replaces it.

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
- A macOS system quit (Dock, logout, Apple Event) is AppKit's `terminate:`,
  which Tao's delegate does not answer. `src-tauri/src/quit.rs` adds only
  `applicationShouldTerminate:` to Tao's existing delegate class during
  setup. It always cancels and calls `app.exit(0)`, so the gate decides.
  Do not let it return anything but cancel, keep state, take a lock, or
  replace the delegate. If the delegate class changes or already answers the
  question, the app must fail to start; do not make it skip the guard.
- After any Tauri, Tao, or macOS upgrade, rerun `bun run test:quit` and
  `evidence/native-quit/late-method-probe.rs`, and record the results in
  `evidence/native-quit/README.md`. The startup checks cannot see whether
  AppKit still asks a method added after the delegate was set.

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
  disposable directory; never test against the default one. Tests fault the
  folder's storage stand-in, never a wrapper around the row editor.
- A commit failure is a Git fact. Do not turn one into a save error, and do
  not make a save wait for a commit.
- `bun run test` must not need Rust. Tests that need the shell live in
  `src-tauri` and `native-tests/` and run with `bun run test:native`. The
  quit harness, `src-tauri/examples/quit`, opens a window and needs a macOS
  login session, so it runs only on its own (`bun run test:quit`). It quits
  its own process in a fresh directory. Never point it at the default folder,
  and never quit another app to test.

## Words a person reads

Say note, folder, file, draft, saved, and commit. Do not put `entry`,
`buffer`, `scope`, `shell`, `baseline`, or `canonical` in anything a person
reads; those are the right words in code and the wrong ones in a status line.
