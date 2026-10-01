# @epicenter/folder

A folder whose current files are the saved data: Markdown rows, `kv.json`, and
any other file, with Git history beside them. There is no document store
behind it. The package does not depend on `@epicenter/app`.

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  id: 'so.epicenter.todos',
  kv: { theme: field.string() },
  tables: {
    todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }),
  },
});

const opened = await openFolder({ definition });
if (opened.error) return show(opened.error.message);
const folder = opened.data;

const stop = folder.onFilesChanged(() => refresh());   // subscribe, then read
const listed = await folder.tables.todos.list();       // { entries, unreadable }
const created = await folder.tables.todos.create({ fields: { title: 'Milk', done: false } });
await folder.tables.todos.update(created.data!, { fields: { done: true } });
await folder.close();
```

## Entries

| Import | Opens | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | The desktop app's folder when the page runs in Tauri, this browser's storage otherwise. Decided when `openFolder` is called, and only the chosen adapter is loaded. | Ordinary application code. |
| `@epicenter/folder/browser` | IndexedDB only. Refuses inside the desktop app. | A web-only build, or a test that injects IndexedDB. |
| `@epicenter/folder/tauri` | The desktop shell's folder only. Refuses outside it. | A desktop-only build. |
| `@epicenter/folder/bun` | An existing directory, in Bun. | Command-line tools, recovery scripts, and tests that are given a directory. |

The first three export the same `openFolder` signature and the same contract,
so one application source builds against any of them. Importing an entry opens
nothing. On a server, opening returns a refusal.

```ts
openFolder({
  definition,
  id,        // optional: which folder. Defaults to definition.id. Never a path.
  browser,   // optional: { author, remote, commitOnEdit, indexedDb }
}): Promise<Result<Folder, OpenFolderError>>
```

`browser` applies to a browser folder only. A browser folder commits under a
local author by default and commits each save automatically; a `remote` needs
an explicit `author`. In the desktop app the shell owns the directory, the
author, the remote, and the history policy. The policy in effect is on
`folder.git.snapshot` either way.

A desktop page whose folder cannot be opened (no plugin, no permission, an
unregistered ID, another protocol version, a folder another process holds)
gets that refusal. It is never given browser storage instead.

### Building for one environment

Alias the exact bare specifier. Do not rewrite subpaths.

```ts
// vite.config.ts
resolve: {
  alias: [{ find: /^@epicenter\/folder$/, replacement: '@epicenter/folder/tauri' }],
}
```

With `/tauri`, no browser storage and no Git implementation is emitted. With
`/browser`, no desktop adapter is emitted. Without an alias, both adapters are
emitted as separate chunks and neither loads until a folder is opened.
`evidence/bundles` builds these and reads the output.

The shell's terminal uses just-bash, whose browser bundle references
`node:zlib` for gzip commands the terminal does not enable; an application
aliases that module.

### The directory entry

```ts
import { openFolder } from '@epicenter/folder/bun';

const opened = await openFolder({
  root: '/path/to/an/existing/directory',
  definition,
  git: { author: { name: 'Tool', email: 'tool@example.test' }, commitOnEdit: false },
});
```

This is a different opener: it takes the directory and the history settings
explicitly, and this process records history itself with the `git` program. It
is not the desktop adapter, and it does not watch the directory.

## The handle

| Member | Contract |
| --- | --- |
| `tables.<name>` | Rows at `<name>/<stem>.md`. An entry carries its path, exact `source`, `version`, fields, body, and `issues`. `get(stem)` returns `undefined` only for absence. `list()` keeps invalid readable rows as entries and reports undecodable files in `unreadable`. `create` is exclusive. `update`, `writeSource`, `rename`, and `delete` take a captured entry and refuse if the file changed. Each changes exactly one Markdown file. |
| `kv` | Root `kv.json`, read and conditionally replaced like an entry. |
| `files` | Ordinary files at literal paths. See below. |
| `batch(collect)` | Several mutations under one admission, one application, and one history request. See below. |
| `git` | A status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, and `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
| `location` | `{ kind: 'indexedDb', database }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | A hint that paths changed, so read again. Returns the function that stops listening. |
| `terminal({ cwd })` | A shell over the folder's files and history. |
| `signal`, `close()` | Closing fences new work and stops network work, lets admitted saves and Git work settle, then releases storage. It makes no final automatic commit. |

### Files

```ts
const made = await folder.files.create('audio/take.webm', bytes);   // refused if anything is there
const read = await folder.files.read('notes/a.md');                 // { path, version, bytes }
const next = await folder.files.replace(read.data!, 'new text');    // refused if it changed since
const moved = await folder.files.move(next.data!, 'notes/b.md');    // refused if either end changed
await folder.files.remove(moved.data!);
await folder.files.overwrite('settings.txt', 'on');                 // whatever is there
```

The verb states the condition. `replace`, `remove`, and `move` act on a
**capture**: a plain, frozen `{ path, version }`, where `version` is the
SHA-256 and size of the bytes it was captured from. A capture holds nothing
open, can be serialized, and never changes. A successful save returns a new
capture; the one passed in stays what it was. A table entry is a capture of
its row file, and so is a `read` result.

- Strings are saved as UTF-8 with nothing added or normalized. Byte arrays are
  copied when the method is called, so reusing the array afterward changes
  nothing.
- A save's capture is computed from the bytes it was given. Nothing is read
  back. If another writer lands right behind the save, the capture still names
  what this save wrote, and the next `replace` with it is a `Conflict`. Read
  the file to observe what is there now.
- A moved file's capture is the captured version at the new path.
- `create` refuses an occupied path even when the bytes are identical.
- A stale capture is a `Conflict`. Nothing is merged, replayed, or retried.

`list`, `children`, `open` (stable bytes for consumption), `mkdir`, and `rmdir`
are unchanged.

### Tables own only their row files

A table reads and writes one Markdown file per row. A file that shares a
row's stem, such as `recordings/take.webm` beside `recordings/take.md`, is an
ordinary file. It is not part of the entry, does not block creating the row,
and stays where it is when the row is renamed or deleted. An application that
keeps media records the path in a field or a Markdown link and manages those
files through `files`. Nothing scans references, repairs links, or collects
unreferenced files.

`update` patches the captured source: it replaces only the touched frontmatter
value spans or appends new keys, and refuses rather than rewriting YAML it
cannot patch safely. Comments, quoting, key order, unknown keys, a byte-order
mark, and CRLF line endings survive. `writeSource` writes the supplied text
exactly, so invalid frontmatter can be saved and repaired. A row whose
frontmatter cannot be interpreted stays a readable entry with `issues`.
`patchSource` and `readSource` are exported for editors that keep their own
buffer.

`get` refuses a stem containing a path separator, and entry operations refuse
a nested path such as `todos/a/b.md`. A row whose external filename violates
the stem rules stays listable and editable.

### Batches

```ts
const receipt = await folder.batch((batch) => {
  batch.files.create('audio/take.webm', audio);
  batch.tables.recordings.create({ stem: 'take', fields: { title: 'Take', audioPath: 'audio/take.webm' } });
});
```

The callback runs once, synchronously, and returns `undefined`. It only
collects mutations: the file verbs of `files`, and a typed row `create` at a
stem the caller supplies. There is nothing to read and nothing to await inside
it. The collector is sealed when the callback returns; using it later throws.
A callback that throws, or returns a promise or any other value, publishes
nothing. Bytes are copied when each mutation is collected.

The batch is published through one application of the file boundary and
requests history once. On success the receipt lists the landed steps in order,
each with the capture it left (`remove` leaves none). Those captures come from
the collected bytes and from a moved file's captured version, never from a
read. Reading afterward is a separate observation and may see another writer's
bytes.

- A browser folder applies the whole batch or none of it.
- A folder on disk applies ordered steps. When a later step fails, the result
  is `Partial` with the steps that landed; nothing is rolled back and no
  commit is requested. An `Unconfirmed` result means the reply was lost: look
  at the folder before publishing again.
- A batched row's destination is checked the way a standalone `create` checks
  it, by the same function, before anything is published: an occupied path is
  `Exists` and a case-colliding sibling is `Collision`, and the whole batch is
  refused. The table directory's names are listed once, then the plan is
  walked in order, so a row may take a name that an earlier step of the same
  batch removed or moved away, and two collected rows that collide are
  refused. Like the standalone check, it is best effort against other
  programs writing the directory.

To finish a recording whose audio landed but whose row did not, read the
audio, verify it is the pending recording's, then publish
`batch.files.replace(observed, pendingBytes)` and the row in one more batch.
The replace lands only if the audio is still exactly what was observed.

### Hints

`onFilesChanged` says which paths a change reached, as a request to read again.
There is not one call per save, calls are not ordered against other writers,
and a hint is never a capture. Subscribe before the first read so nothing falls
between them. Closing stops all listeners at once, including the ones still
waiting in a dispatch that a listener closed the folder from.

A listener runs inside the save that caused the hint. What it throws is
logged and goes no further: the save still returns its capture, still
requests its commit, and the other listeners still hear. The same holds for a
`git.subscribe` subscriber.

| Folder | Announces |
| --- | --- |
| Desktop | Every change the owner sees: this window, other windows, and other programs. |
| Browser | This handle's saves and incoming updates, and those of other tabs on the same origin. |
| Directory (Bun) | This handle's saves and incoming updates. Other programs are not watched. |

### Terminal

`folder.terminal()` runs a just-bash shell over the same files, loaded when
its first command runs. Its `git` command supports `status`, `diff [--cached]`,
`log`, `add`, `commit -m`, `push`, `fetch`, and `pull --ff-only`. A redirection
is a deliberate overwrite; a rewrite of a file the same command read is
conditional on what it read. `add` and staged `commit -m` need
`commitOnEdit: false`. In the desktop app each command holds the folder for its
run, so no other window's save lands between its reads and writes. The
terminal ends with the folder.

## History

Browser handles, Bun directory handles, and the desktop app's Rust owner follow
the same history rules. Where the desktop owner differs, this section says so.

A save returns once its files are published and never waits for Git. A commit
pins the branch head, captures every source file, writes a commit with a
subject derived from the tree difference, and moves the branch only with a
compare-and-swap. A moved branch is reported and not retried. Commit and push
failures never undo a save.

With `commitOnEdit` (default `true`), each complete table, KV, file, or batch
save this handle published makes one commit attempt in the background. The
attempt runs only if the folder's Git work is free at that moment. If another
tab, a pull, a staged command, or an earlier commit holds it, the attempt
does not happen and is not made up later: the save stays uncommitted until
the next save or an explicit `commit()`. An attempt that fails is reported in
`git.snapshot.lastCommit` and is not retried. There is no timer and no commit
when the folder closes, so the last save can stay uncommitted indefinitely.
Browser attempts require Web Locks. Without that API, automatic attempts
are skipped; explicit commits still run and use branch compare-and-swap.
Edits made by another program or tab, and saves that stopped partway, make no
attempt. `git.snapshot.files` turns `stale` when a save lands after the last
capture, and `git.status()` lists what is uncommitted.

After an attempt that ran, a push is attempted if a remote exists, the branch
is ahead of it, and no push is running; a push that does not start or fails is
not owed. `commit()` stays local. `commitAndPush()` commits and then pushes;
a caller `signal` only stops that caller waiting, and a caller that stopped
during the commit starts no push. An explicit request waits for the folder's
Git work and then reads the folder, so it includes saves made while it
waited. If the folder closes while it still waits, it is told `closed` and
nothing runs.

Source files are tracked files plus untracked files that `.gitignore` does not
exclude; the root `index.sqlite3` and private Git state never are. Plain Git
records binary files like any other file. There is no default audio ignore, no
format list, and no LFS.

### Closing

`close()` fences new file work, stops hints, refuses new Git requests, and
cancels pushes and fetches. Already admitted saves finish. A Git request still
waiting for admission is refused; work that already entered its protection
settles before storage is released. No final commit is required, and saved
files can remain uncommitted after close.

In the desktop app, closing detaches this page. The owner keeps the folder,
finishes the saves, the commit, and any push or fetch it had already started
for the page, and serves every other window. A push or fetch of the page that
the owner had not started is withdrawn and never starts. The owner makes no
commit because a page closed or the app quit: a save whose attempt was skipped
stays uncommitted there too.

One desktop difference follows from the owner being shared by every window: a
save made by a terminal command is not committed on its own, because the
command holds the folder for its run. `git commit` in that terminal, or the
next save made with the folder free, commits it.

### Incoming changes

`fetch()` records the remote head. `pullFastForward()` applies it only when
the whole folder, including staged changes, is clean and the update is a
fast-forward. Ignored and untracked files are left alone; an incoming path
that would overwrite one is a `Collision`.

A fast-forward writes each blob's bytes as they are stored. An incoming commit
whose own `.gitattributes` declare a filter or a byte conversion (`filter`,
`text`, `eol`, `crlf`, `ident`, `working-tree-encoding`) for any file in its
tree is refused as `Unrepresentable` before a file, the index, or the branch
changes. That includes a commit that only adds the attribute over files it
does not touch, attributes in nested files, and attributes the folder's
current files would mask. This is refusal, not Git LFS support: pointer-shaped
text with no declared filter is ordinary bytes. The desktop owner and the
directory entry ask `git check-attr --source`; the browser evaluates the
commit's attribute files the same way, matching patterns as a case-insensitive
checkout does.

A browser publishes files, index, and branch in one transaction. A folder on
disk applies ordered file steps, updates the index, and moves the branch last;
a failure reports the steps that completed, marks the saved-files observation
stale, and requests no commit.

A whole-folder commit or fast-forward on disk writes every file as plain
`100644` bytes, so it is refused in a repository it would misrepresent:
symbolic links, executables, submodules, nested `.git` data, `core.autocrlf`,
or a normalizing attribute on a source file. Reads and file saves still work.

## Declaring a folder

`defineFolder` checks the definition where it is written. `defineTable` and
`field` are the vocabulary every Epicenter storage shares
(`@epicenter/definition`). A folder refuses a table that declares a body
conversion, because a row's body is the file's Markdown text, and a reference
field, because renaming a row file would not repair what points at it. An
opener given such a definition returns `InvalidDefinition` before it acquires
anything.

## Layout

| Path | What it is |
| --- | --- |
| `src/contract.ts` | Everything an application names besides the opener. Every entry exports it unchanged. Loads no storage, Git implementation, or runtime module. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts` | The entries. |
| `src/browser-adapter.ts`, `tauri-adapter.ts` | The adapters the automatic entry loads lazily. |
| `src/folder.ts`, `table.ts`, `kv.ts`, `batch.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter. |
| `src/browser-store.ts`, `git/browser-*.ts` | IndexedDB storage and isomorphic-git. |
| `src/native-store.ts`, `git/native-*.ts` | The directory entry's files and `git` program. "Native" here means an ordinary directory in Bun, not the desktop shell. |
| `src/native/bindings.gen.ts` | Commands and events generated from the `tauri-plugin-epicenter-folder` crate. Internal. Do not edit. |
| `evidence/` | Tests that build real bundles and read real import closures. |

## Commands

```sh
bun test --isolate        # everything except the real desktop owner
bun run typecheck
EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts   # against the Rust owner
bun evidence/bundles/inspect.ts main tauri   # print the chunks a build emits
```

## Limits

Reference fields are refused, since rename repairs no references. `kv.update`
rewrites `kv.json` whitespace. Browser bytes are stored whole, and every commit
or status check reads the whole folder. Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.
