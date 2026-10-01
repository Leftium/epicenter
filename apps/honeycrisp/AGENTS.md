# Honeycrisp App

File-authoritative Markdown notes. Read [the README](README.md) for how the
page, the desktop shell, and the folder plugin fit together, and verify it
against the code. The constraints below apply to every edit here.

## The files are the data

- The notes directory's current files are the saved data, and `<root>/.git`
  is ordinary Git. Do not add a second store beside them: no IndexedDB copy
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
- Change a note's text as a patch to its source through
  `src/lib/note-source.ts`, saved by the file's session. Do not re-emit
  frontmatter: unknown keys, comments, quoting, and key order belong to the
  person.
- Tables are listings. Read `folder.tables.*.list()` and nothing else from a
  table: a note's fields, a folder's name, a new note, and a deleted folder
  are all changes to a file's source. Do not add a second way to save a note.

## One session per file, one buffer

- Every open text file has one session, `createFileSession` in
  `src/lib/file-session.svelte.ts`, kept by path in `notes.svelte.ts`. A
  note and a raw file are the same kind of session. Do not branch on which
  one a path is to save, move, delete, or recover it.
- That module is the only place that asks the folder to create, replace,
  move, or remove a file, and the only place that reads the folder's reply.
  Every such call names a capture: `files.create(path, …)`,
  `files.replace(capture, …)`, `files.move(capture, to)`,
  `files.remove(capture)`. Do not use `files.overwrite`.
- The session's `buffer` is the whole source text. The rich-text view, the
  Source view, and the metadata controls are all views of it. Do not give
  any view state the buffer does not hold.
- Keep `saved`, `buffer`, `attempt`, `pathChange`, and `external` separate.
  `saved` is the folder's capture plus its text, and it is the baseline. A
  write acknowledges the text it submitted at the capture the folder
  returned; never read the file to find out what was saved, and never let
  the owner hand a session a new base.
- A refused or failed write does not move `saved` and does not clear
  `external`.
- A review choice names the `external` object the person was shown.
  `saveMine` and `takeTheirs` refuse any other, so a newer observation
  invalidates the choice. There is no unconditional overwrite.
- An unconfirmed write stays exactly as it was sent: path, text, condition.
  Nothing more is saved while it does, and retry sends that same write, never
  the newer buffer. No read removes it. The old file, no file, or other text
  does not show the command cannot still land; other text is recorded beside
  it as `external`, and none of them becomes the base. That holds when the
  buffer equals the saved text too: a session with a write still out adopts
  nothing.
- An unconfirmed write ends in two ways only: a successful reply to a
  reissue of that same write, or a read of exactly its text at its path.
  The second says what the file holds, not which command wrote it. It makes
  that text `saved`; newer typing is then dirty against it, and the read
  itself starts no save. Only a confirmed write restarts the autosave timer;
  after a read, the newer typing is saved by the **Save** control, the next
  edit, or a close. Do not add a way for the person to drop an attempt.
- A save takes the buffer as it is when `save()` is called, and chooses its
  condition when its turn comes. Do not move the capture into the queue.
- An unconfirmed or partial move, and an unconfirmed removal, of an open
  file is kept as `pathChange`. Nothing is saved, moved, removed, or
  concluded from a read while it stands, and the session is not forgotten.
  Do not add a retry, a way to pick a path, or any cleanup: which file to go
  on with is not something this app can show.
- A change to a file with no open session whose outcome is unknown is kept
  in `notes.pending` as it was sent. It blocks further changes to its paths
  and a second create of the same kind. `create`, `replace`, and `mkdir`
  records end on a read of exactly what they asked for, or a confirmed
  resend; `move`, `remove`, and `rmdir` records do not end. Do not report
  one as failed, resend one without the person asking, or make a new one
  under a fresh name.
- Every change with no session goes through `send` in `notes.svelte.ts`. It
  checks the fence in the step it makes the call, registers the call before
  anything is awaited, and records an unknown outcome in the step the reply
  arrives. Do not call the folder for such a change any other way, and do
  not put an await between the fence check and the call. Directory calls go
  through the same reply mapping as files, so a call that throws is kept as
  not confirmed.
- `notes.unsettled` and `settleAll` count pending records and changes still
  being sent, not only drafts. A close waits for what was sent and asks
  about what was never confirmed.
- Do not report any of these as "not saved".
- Rename and delete act on the version the session holds, or on a version
  captured when the person was asked. Do not read the file again to get
  permission.
- Saving a removed file's draft uses another path only when a first,
  confirmed refusal shows other text at its own path. A retried attempt
  never does: the occupant may be its own earlier write.
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
- A view shows only text the session took. `input` returns false when it did
  not; `RichSession.apply` refuses that transaction.
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
