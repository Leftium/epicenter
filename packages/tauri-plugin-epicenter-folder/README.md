# tauri-plugin-epicenter-folder

One native owner per folder, shared by every window of a Tauri shell.

A shell registers a directory under a scope ID and names the windows that may
use it. The Rust owner publishes files, records Git history when the folder is
free, and tells every attached window what changed. A page names the scope and nothing else: it
never supplies a root, an author, a remote, or a commit policy.

## Layout

| Path | What it is |
| --- | --- |
| `core/` | `epicenter-folder-core`: the owner, the registry, and the cross-process lock. No Tauri; its tests need only `git` and `bun`. |
| `src/` | The Tauri plugin: commands, events, sessions. |
| `../folder/src/native/bindings.gen.ts` | TypeScript commands, events, and types, generated from the Rust plugin into `@epicenter/folder`, whose desktop adapter is their only user. Do not edit. |
| `fixtures/commit-subjects.txt` | Commit subject vectors shared by the Rust port and `commitSubject` in `@epicenter/folder`. |

This crate has no JavaScript package of its own. A page reaches it through
`@epicenter/folder` (or `@epicenter/folder/tauri`).

## Registering folders in a shell

Install the plugin once. Register each folder from trusted Rust code after the
shell has resolved its paths, which is in `setup`, not before:

```rust
use tauri_plugin_epicenter_folder::{Author, FolderConfig, FolderExt, ScopeConfig};

tauri::Builder::default()
    .plugin(tauri_plugin_epicenter_folder::init())
    .setup(|app| {
        let todos = resolve_todos_directory(app)?;
        app.folders().register(ScopeConfig {
            scope: "so.epicenter.todos".into(),
            folder: FolderConfig {
                // Keep the identity and the `origin` a person already
                // configured in this directory; `author` is the fallback.
                use_repository_author: true,
                use_repository_origin: true,
                ..FolderConfig::new(
                    todos,
                    Author { name: "Todos".into(), email: "todos@localhost".into() },
                )
            },
            windows: vec!["todos".into()],
        })?;
        Ok(())
    })
```

Grant the windows the plugin's commands in a capability:

```json
{ "windows": ["todos"], "permissions": ["epicenter-folder:default"] }
```

The capability only lets a window call the plugin. Which folder it reaches is
decided by `windows` in `ScopeConfig`. A scope's configuration cannot change
once registered.

`FolderConfig` fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `branch` | `main` | The local branch, and the remote branch when a remote exists. |
| `author` | required | Who commits. With `use_repository_author`, the fallback for whichever of name and email the repository does not configure. |
| `remote` | none | Where to push and fetch. |
| `commit_on_edit` | `true` | Whether a complete save attempts a local commit. Transfers are explicit. The attempt is skipped when the folder is busy; see "Automatic commits". |
| `use_repository_author` | `false` | Read `user.name` and `user.email` when the folder opens. |
| `use_repository_origin` | `false` | Read `remote.origin.url` when the folder opens and use it as the remote. |
| `watch_events` | `true` | Watch filesystem events for changes made outside the owner. |
| `watch_interval` | 2 s | Also compare file sizes and times this often. |

The two `use_repository_*` options select author and transfer destination
independently. Neither enables automatic network work. Leaving
`use_repository_origin` off means an `origin` configured in the directory is
never read. A
`remote` given in `FolderConfig` is used either way, and is the fallback when
origin discovery is on and the repository has no `origin`. Both are read once,
inside the open, after the cross-process lock is held and the Git layout is
verified.

## Using a folder from a page

```ts
import { openFolder } from '@epicenter/folder';

// The scope is the folder's ID, which the page names; the definition names none.
const opened = await openFolder({ id: 'so.epicenter.todos', definition });
if (opened.error) return show(opened.error.message);
const folder = opened.data;

folder.location;                // { kind: 'directory', root }, for showing to a person
await folder.tables.todos.create({ stem: 'buy-milk', fields: { title: 'Buy milk', done: false } });
folder.git.subscribe((snapshot) => render(snapshot));
folder.onFilesChanged((paths) => refresh(paths));
const terminal = folder.terminal();
await terminal.exec('git status');
await folder.close();           // detaches this page only
```

`openFolder` returns its refusals: an unknown scope, a window the scope does
not list, a folder another process holds, a shell without this plugin, and a
desktop app built for another protocol version. The unreleased protocol is
version 5: version 4 added the number every `apply` names, and version 5 the
incoming record, `recover_incoming`, and the refusals a pending update
causes. No command holds the folder across calls or names a terminal lease.
A page built for a different version is refused at attach. It never opens
browser storage instead. `@epicenter/folder/tauri` is the same opener without the
browser adapter in the build.

## File changes

A read returns `{ bytes, sha256 }`. The owner computes the hash from the bytes
it read. `apply` takes ordered changes, each one of:

| Change | Fields | Lands when |
| --- | --- | --- |
| `create` | `path`, `bytes` | Nothing is at the path. |
| `replace` | `path`, `bytes`, `expectedSha256` | The file's bytes hash to `expectedSha256`. |
| `overwrite` | `path`, `bytes` | Always, whether or not a file is there. |
| `remove` | `path`, `expectedSha256?` | The file exists and, when a hash is named, its bytes match. |
| `move` | `from`, `to`, `expectedSha256?` | The source exists, matches a named hash, and nothing is at `to`. |

- No change carries the hash of its new bytes. The owner hashes what it reads
  from the folder and never trusts a hash a page computed for new content.
- A `remove` or `move` without `expectedSha256` is a deliberate unguarded
  operation, for a shell acting on whatever is there. Changes built from a read
  name the hash.
- `Conflict` is `{ path, expectedSha256, actualSha256 }`: the bytes differ from
  the named hash. `actualSha256` is `null` when a `replace` target is missing.
- `Exists` is `{ path }`: a `create` target or a `move` destination already
  holds a file.
- A missing `remove` or `move` source is `NotFound`.
- Paths are literal. A filesystem that folds case or normalizes Unicode, as
  APFS and NTFS do, can resolve `note.md` to an existing `Note.md`, or
  `dir/` to an existing `Dir/`. Every change refuses such a spelling, of
  the path or of a directory on the way, before writing anything:
  `InvalidPath` names the existing spelling, and a `create` target or
  `move` destination that is one is `Exists`. A read of such a spelling is
  `NotFound`: no file has that name. Where the filesystem holds both names,
  each is its own file.
- `apply` also takes `submission`, the batch's number in its page.
  `Superseded` is `{ path }`: a batch of the same page numbered at or after
  this one already landed on the path, so this delivery wrote nothing.
  Whether the batch itself landed through another delivery is unknown. See
  [Locking and ordering](#locking-and-ordering).
- The steps reported in a partial batch are `write`, `remove`, and `move`:
  they say what landed, not which kind of change asked for it.

A fast-forward publishes through the same changes: `create` for an added path,
`replace` and a guarded `remove` conditional on the committed bytes. It never
removes or replaces a file without that guard, and refuses before writing
anything if it cannot name one.

## Incoming updates and their recovery

A fast-forward changes files, then the index, then the branch, and a process
can stop between any two (ADR-0474). Before it changes anything, it pins its
before and after commits under `refs/epicenter/incoming/<operationId>/` and
writes one record, `.git/epicenter/incoming.json`, holding exactly
`operationId`, `branch`, `expectedHead` (`null` for an empty history), and
`nextHead`. The record is written to a scratch name, flushed, and renamed into
place. Every path, byte, and index entry is derived from the two pinned trees,
so a later fetch that moves the tracking ref, or a garbage collection, cannot
take the target away. Ordinary saves keep no record.

- **While a record exists**, saves and fetches carry on. Commits, automatic
  commits, staging, staged commits, and new fast-forwards are refused:
  `CommitOutcome` `blocked`, `GitError` `IncomingPending`, and `PullError`
  `IncomingPending`. The snapshot's `pendingIncoming` reports it: `recorded`
  with the four fields, or `unreadable` with the exact reason a record could
  not be read. Opening the folder and `status` read it and never resume it.
- **`recover_incoming`** runs only when asked, under the file gate and the
  Git lock, and reads everything again:
  - nothing pending: `{ status: 'none' }`;
  - the branch already names `nextHead`: the record and pins go, no file is
    written, and later edits stay: `{ status: 'cleared', pending }`;
  - otherwise each changed path must hold its before or its after state, the
    index must hold nothing staged but the update's own entries, and the
    branch must still name `expectedHead`. Paths still at their before state
    are written, removals first, each conditional on the bytes it was found
    with; every path is checked for its after state; the index is written
    through Git's lock; the branch moves by compare-and-swap; then the record
    goes, then its pins: `{ status: 'completed', pending, changedPaths }`,
    where `changedPaths` are the paths this recovery wrote or removed.
  - Recovery looks only at the paths the update changes. Files edited while
    it was pending stay as they are, so after `cleared` or `completed` the
    files observation is marked stale and a real status follows; nothing is
    reported clean that was not looked at.
- **What stops it** keeps the record and writes nothing, or reports what it
  wrote. `RecoveryRefused { pending, paths, reason }` names third bytes, a
  missing file, an empty file where a nonempty one is added (that is not
  absence), a file or directory in the way, a foreign or mixed index entry,
  an unreadable index, a moved branch, HEAD off the branch, an unreadable
  record, or a missing pinned commit. `Partial`, `IndexFailed`, `BranchMoved`,
  and `Unconfirmed { applied, uncertain, error }` say what landed and what is
  unknown; the record stays, and nothing infers that a step did not happen.
- **Files and directories trade places.** A removal goes first, so a file can
  become a directory. Where a file must go and a directory is, the before
  tree says which directories are Git's: those, emptied by the update's
  removals now or by an earlier attempt, are removed deepest first. Any
  other file or directory there, even an empty one, stops the update before
  it writes, and no other directory is pruned.
- A fast-forward whose first look finds a path in neither state, before it
  writes anything, withdraws its record and pins and reports `Dirty`,
  `Collision`, `StagedChanges`, or `BranchMoved` as before. Once it has
  written, it stops like a recovery and keeps its record.
- When the branch moved but could not be read back, or moved and its record
  could not be removed, the fast-forward or recovery is reported as
  published, because the branch did move, and the snapshot still reports
  the record. A later recovery finds the branch at the target and clears it
  without writing a file.

## Lifetimes

- **The owner** opens on a scope's first attach and stays open until the app
  exits or the shell calls `app.folders().shutdown()`. Shutdown refuses new
  work, lets admitted saves and admitted commits finish, cancels pushes and
  fetches, and releases the lock. It commits nothing of its own: a save whose
  automatic attempt was skipped, or which lands after shutdown began, stays
  saved and uncommitted. A commit or fast-forward still waiting for the
  folder when shutdown begins is refused as closed.
- **A session** belongs to the window that attached it. Another window that
  names it is denied. A session ends on `detach`, when its page reloads, and
  when its window is destroyed. Ending a session never cancels a save, a
  commit, or a push or fetch the owner already started, and never affects
  another window. It withdraws the session's pushes and fetches that the
  owner had not started.
- **`folder.close()`** in a page refuses that page's new file, Git, and
  terminal calls without invoking anything, stops waiting for its pushes and
  fetches and withdraws them, waits for the Git calls it already sent, and
  then detaches. It does not wait for file calls already sent: one the
  owner admitted before the detach still lands and replies to its caller,
  and one that arrives after it is denied and writes nothing. A save that
  had reserved its place but not yet been sent is refused as closed. A
  terminal command running then sends no later step. Close commits nothing.
  A page that needs its saves settled first awaits them, or disposes its
  editors, before closing.
- **A terminal command** holds nothing. Each of its steps is an ordinary
  command of its session, so other windows' saves land between its steps. A
  rewrite of a file the command read names the hash it read and is
  refused as a `Conflict` if the file changed since. A command that stops
  partway leaves its earlier steps landed.

Each webview keeps its own lifecycle identity in its resource table. The plugin
holds a weak index so it can end sessions after Tauri removes a destroyed
window from its manager. A retained handle to the old webview cannot attach to
or end the sessions of a replacement that reuses its label. Reload cleanup
removes only ended sessions, so an attachment from the new page survives it.

## Locking and ordering

- **Across processes.** The owner holds an exclusive SQLite transaction on
  `.<directory>.epicenter-lock` beside the directory, the same file and
  mechanism the Bun hosts use, so only one process owns a folder. The system
  releases it when the process ends, however it ends. It is unreliable on
  some network filesystems.
- **The file gate** admits one publication at a time: an `apply` batch, a
  directory change, or a fast-forward's file changes. It is held for that
  one publication and never across commands.
- **A page's saves** keep the order the page asked for them in. A save can
  finish hashing or reading after a save asked for later, can reach the
  plugin late, can be delivered twice by Tauri's IPC fallback, and can wait
  for a worker before it reaches the gate, which is not first come, first
  served. So every public method that saves takes the page's next number
  synchronously when it is entered, before any of that, from one sequence
  for every folder handle and root of the page; `submission` carries it.
  The plugin keeps one writer per page and canonical root, shared by every
  session the page attaches there, including one attached after detaching.
  Under the gate, a delivery is refused as `Superseded` (`{ path }`), with
  nothing written, if a save of the page numbered at or after it already
  landed on one of its paths. That covers both a stale save and a second
  delivery of one whose first delivery landed, and once a later save has
  landed the record cannot tell them apart. So the page reports every
  `Superseded` as unconfirmed: this delivery wrote nothing, and whether an
  earlier delivery landed is unknown. It never reports it as success or as
  a save that definitely failed. `submission: 0` is refused as `Denied`.
- For each path, the writer keeps the highest number that landed there, in
  memory, for as long as the page lasts: a page with nothing in flight may
  still have an earlier save on its way. Other paths are not ordered against
  a save, and neither are other pages: between windows, and between a page
  and the page that replaced it on reload, the last save to land wins. A
  save the plugin took before its session ended keeps the page's record and
  still lands unless refused; one that arrives after the session ended is
  denied and writes nothing. Two scopes cannot hold one root at once, since
  the second cannot take its lock. Directory changes are not numbered.
- **The Git lock** orders commits, staging, and ref updates.
- Pushes and fetches run outside both. A transport in flight delays no save
  and no commit.
- A commit takes the file gate and then the Git lock. Under both it pins the
  branch head and hard-links the folder into a snapshot. It then releases the
  file gate and, still under the Git lock, hashes the snapshot and moves the
  branch with a compare-and-swap. A save never waits for hashing.
- An explicit commit, fast-forward, or status waits for the file gate. With
  the gate held, a commit or fast-forward tries the Git lock. If it is busy it gives the gate back,
  waits for the Git lock to be released, and starts over, so it reads the
  folder as it is once it holds both.
- Nothing waits for the Git lock while holding the file gate, and nothing
  takes the file gate while holding the Git lock.

## Automatic commits

With `commit_on_edit`, a complete `apply` batch makes one automatic commit
attempt. The owner takes the file gate and then the Git lock only if each is
free at that moment, and decides before the save returns.

- If either is held, the attempt did not happen. Another save, a commit, a
  fast-forward, or a staging call can be the holder.
  Nothing is recorded, nothing runs when the holder lets go, and no timer
  tries again.
- A skipped save stays uncommitted until a later save's attempt or an
  explicit commit includes it. It can stay uncommitted indefinitely.
- A terminal's save makes the same attempt as any other save. A redirection
  publishes the empty file and then its content, so its second attempt can
  find the first still running and be skipped.
- A partial, refused, or unconfirmed batch makes no attempt.
- Automatic commits stay local. Only an explicit push request starts outgoing
  transport, even when a remote is configured.
- A page is never told that an attempt was skipped and has nothing to retry.
  `snapshot.activity.commit.active` is true while a commit runs, and the
  files observation is stale after any save the last commit did not cover.

An explicit `commit` waits for the folder instead, reads it once it holds both
locks, and replies with what it did. It never pushes; `commitAndPush` in a
page sends the push as its own command, and only while that caller is still
waiting.

## Pushes and fetches

The owner runs one push at a time and one fetch at a time. A request that
arrives while one is running waits, and every request that arrives during
that run shares the one that follows it. Receiving a command is not starting
its transport: the owner starts a waiting push or fetch only when the running
one has finished, and until that moment its callers can withdraw.

A page asks in two steps. `open_request` registers a request in the page's
session and returns its number; `push` or `fetch` then names it. Because the
owner knows the request before any command names it, `withdraw_request` can
never arrive too early to matter.

- A page asks for nothing on behalf of a caller whose signal has already
  aborted.
- Withdrawing a request, or ending its session, removes that caller from the
  waiting push or fetch. If no other caller is waiting for it, it never
  starts. Other callers sharing it keep it, and it runs once for them.
- A `push` or `fetch` naming a request that was withdrawn, has finished, or
  was never opened by that session is refused and starts nothing. A request
  serves one command; a second command naming it is refused.
- A transport the owner has already started is the owner's. Withdrawing its
  request, or ending its session, does not stop it, and it runs to its end.
- A request belongs to the session that opened it. Another window cannot use
  or withdraw it, even with the number.
- Pushes and fetches are ordered separately. A request is withdrawn from each
  in turn, and a waiting push or fetch is told it was withdrawn only by the
  step that also takes it out of its own queue. It is never told so while it
  can still start.
- A page whose caller left is told `stoppedWaiting` at once. That says the
  caller stopped waiting; whether the transport had started is not known to
  the page at that moment.
- Shutdown stops the running push and fetch and settles the waiting ones as
  cancelled or closed without running them.

## Noticing outside changes

The owner watches filesystem events and also compares sizes and times every
`watch_interval`. An event makes the owner look at the path it names even when
its size and time are unchanged. Events inside `.git` are ignored except
`HEAD`, the index, and refs, which make the owner check whether history moved.

An event cannot say who wrote the file, so the owner reports every announced
path, its own writes included. A window may therefore hear `filesChanged` for
a file it just saved, and the Git snapshot's file observation turns stale
until the next status or commit. A report requests no scan and no commit, so
the owner's own events do not feed themselves, and a change made outside the
app is never committed until a save or an explicit commit includes it. The periodic
comparison does know the owner's writes and stays quiet about them.

Where the platform cannot watch the directory, the owner
logs a warning, reports it through `FolderOwner::watch_diagnostic`, and relies
on the periodic comparison, which cannot see an edit that restores size and
time.

## What is best effort

- A `replace` hashes the current bytes and replaces them only when they match
  `expectedSha256`, checking once before staging and again before the rename.
  Another program can still write between that second check and the rename. The owner orders its own windows; it does not lock files against
  other programs.
- A multi-file batch is ordered steps. A failure partway reports which steps
  landed; nothing is rolled back.
- A snapshot is exact against the owner's own writes, which replace files by
  rename or link. A program that edits a file in place can change bytes a
  snapshot links to while it is being hashed.
- A fast-forward or recovery checks every path before it writes and each
  write's own condition again, but another program can still write between
  a check and a rename. Its record keeps a stopped update from being
  committed as a mixed tree; it does not make the transition atomic.
- A commit whose compare-and-swap lost to another Git process is reported as
  `branchMoved` and is not retried. A commit whose branch update landed is
  reported as committed even if the owner could not read the branch back
  afterward; the observation is marked stale instead.
- An outcome the owner or the transport could not confirm is reported as
  `Unconfirmed` and is never retried. Look at the folder before trying again.
- File bytes cross IPC as JSON number arrays. That is acceptable for Markdown
  and slow for large audio saves.

## Commands

```sh
# from this directory
cargo test --offline --workspace          # core and plugin, real Git, mock Tauri runtime
FOLDER_WRITE_BINDINGS=1 cargo test --offline -p tauri-plugin-epicenter-folder bindings
                                          # rewrite ../folder/src/native/bindings.gen.ts

# from packages/folder
bun run gen:vectors                       # rewrite this crate's fixtures/commit-subjects.txt
bun test src/git/commit-subjects.test.ts  # the fixture matches commitSubject
bun test --isolate src/tauri.test.ts
EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts
```

The last command runs the TypeScript adapter against the real Rust owner
through Tauri's invoke handler.

Fast-forward pulls refuse incoming filter and byte-normalizing attributes before
writing files or advancing the branch. The check reads the pinned incoming
revision, including nested `.gitattributes`, rather than the working copy. Pull
requires Git with `check-attr --source` support; an unsupported
option fails the pull before publication. Pointer-looking text with no declared
filter remains an ordinary file. This does not add Git LFS support.
