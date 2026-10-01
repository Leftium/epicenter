# tauri-plugin-epicenter-folder

One native owner per folder, shared by every window of a Tauri shell.

A shell registers a directory under a scope ID and names the windows that may
use it. The Rust owner publishes files, records Git history, and tells every
attached window what changed. A page names the scope and nothing else: it
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
| `commit_on_edit` | `true` | Whether a complete save requests a commit, and a push when a remote exists. |
| `use_repository_author` | `false` | Read `user.name` and `user.email` when the folder opens. |
| `use_repository_origin` | `false` | Read `remote.origin.url` when the folder opens and use it as the remote. |
| `watch_events` | `true` | Watch filesystem events for changes made outside the owner. |
| `watch_interval` | 2 s | Also compare file sizes and times this often. |
| `lease_limit` | 60 s | The longest one terminal command may hold the folder. |

The two `use_repository_*` options are separate because a remote changes what
a save does: with a remote and `commit_on_edit`, every automatic commit is
pushed. A folder that should record history locally under the person's own
identity sets `use_repository_author` and leaves `use_repository_origin` off;
an `origin` configured in that directory is then never read or contacted. A
`remote` given in `FolderConfig` is used either way, and is the fallback when
origin discovery is on and the repository has no `origin`. Both are read once,
inside the open, after the cross-process lock is held and the Git layout is
verified.

## Using a folder from a page

```ts
import { openFolder } from '@epicenter/folder';

// The scope is the folder's ID: `definition.id` unless `id` names another.
const opened = await openFolder({ definition });
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
desktop app built for another protocol version. It never opens browser
storage instead. `@epicenter/folder/tauri` is the same opener without the
browser adapter in the build.

## Lifetimes

- **The owner** opens on a scope's first attach and stays open until the app
  exits or the shell calls `app.folders().shutdown()`. Shutdown refuses new
  work, lets admitted saves and their commits finish, cancels pushes and
  fetches, and releases the lock.
- **A session** belongs to the window that attached it. Another window that
  names it is denied. A session ends on `detach`, when its page reloads, and
  when its window is destroyed. Ending a session never cancels a save or a
  commit the owner already accepted, and never affects another window.
- **`folder.close()`** in a page refuses that page's new file, Git, and
  terminal calls without invoking anything, waits for its local calls and its
  running terminal command, stops waiting for its pushes and fetches (the
  owner keeps running them), and then detaches.
- **A terminal lease** is held for one command and can be used only by the
  session that acquired it. It ends when the command ends, when its session
  ends, or at `lease_limit`.

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
  directory change, a fast-forward's file changes, or a terminal lease.
- **The Git lock** orders commits, staging, and ref updates.
- A commit pass pins the branch head, takes the file gate only long enough to
  hard-link the folder into a snapshot, releases it, and then waits for the
  Git lock. A save never waits for hashing. If the head moved before the pass
  reached the Git lock, it starts over with a fresh snapshot.
- Nothing waits for the Git lock while holding the file gate, and nothing
  takes the file gate while holding the Git lock.

## Noticing outside changes

The owner watches filesystem events and also compares sizes and times every
`watch_interval`. An event makes the owner look at the path it names even when
its size and time are unchanged. Events inside `.git` are ignored except
`HEAD`, the index, and refs, which make the owner check whether history moved.

An event cannot say who wrote the file, so the owner reports every announced
path, its own writes included. A window may therefore hear `filesChanged` for
a file it just saved, and the Git snapshot's file observation turns stale
until the next status or commit pass. A report requests no scan and no
commit, so the owner's own events do not feed themselves. The periodic
comparison does know the owner's writes and stays quiet about them.

Where the platform cannot watch the directory, the owner
logs a warning, reports it through `FolderOwner::watch_diagnostic`, and relies
on the periodic comparison, which cannot see an edit that restores size and
time.

## What is best effort

- A conditional write hashes the current bytes and replaces them only when
  they match. Another program can still write between that check and the
  rename. The owner orders its own windows; it does not lock files against
  other programs.
- A multi-file batch is ordered steps. A failure partway reports which steps
  landed; nothing is rolled back.
- A snapshot is exact against the owner's own writes, which replace files by
  rename or link. A program that edits a file in place can change bytes a
  snapshot links to while it is being hashed.
- A fast-forward that stops partway leaves the landed files in place and the
  branch unmoved, and reports it. Nothing records it for replay; a later
  commit pass may commit those bytes.
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
