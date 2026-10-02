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
await folder.tables.todos.update(created.data!.stem, { fields: { done: true } });
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
| `tables.<name>` | Rows at `<name>/<stem>.md`. An entry carries its path, literal `stem`, exact `source`, `sha256`, fields, body, and `issues`. `get(stem)` returns `undefined` only for absence. `list()` keeps invalid readable rows as entries and reports undecodable files in `unreadable`. `create` is exclusive. `update(stem, change)` reads current source once and conditionally publishes without retry. `replace` and `delete` take a file capture; `rename` takes a captured entry. They refuse if the file changed. Each changes exactly one Markdown file. |
| `kv` | Root `kv.json`. `get()` reads a snapshot; `update(snapshot, values)` merges declared values, preserving unknown fields; `replace(snapshot, source)` saves the complete text. Both writes check the captured version, or create exclusively when the snapshot represents absence. |
| `files` | Ordinary files at literal paths. See below. |
| `batch(collect)` | Several mutations in one application with one history request. See below. |
| `git` | A status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, and `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
| `location` | `{ kind: 'indexedDb', database }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | A hint that paths changed, so read again. Returns the function that stops listening. |
| `terminal({ cwd })` | A shell over the folder's files and history. |
| `signal`, `close()` | Closing fences the next storage call and stops network work. Git work drains before storage is released; file operations own their completion promises. It makes no final automatic commit. |

### Files

```ts
const made = await folder.files.create('audio/take.webm', bytes);   // refused if anything is there
const read = await folder.files.read('notes/a.md');                 // { path, sha256, bytes }
const next = await folder.files.replace(read.data!, 'new text');    // refused if it changed since
const moved = await folder.files.move(next.data!, 'notes/b.md');    // refused if either end changed
await folder.files.remove(moved.data!);
await folder.files.overwrite('settings.txt', 'on');                 // whatever is there
```

The verb states the condition. `replace`, `remove`, and `move` act on a
**capture**: a plain, frozen `{ path, sha256 }`. The hash identifies the exact
bytes captured; byte length remains inventory metadata. A capture holds nothing
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
- A moved file's capture is the captured hash at the new path.
- `create` reports `Exists` for an occupied path even when the bytes are identical.
- A stale capture is a `Conflict`. Nothing is merged, replayed, or retried.

Internally, the same intention reaches each backend as `create`, `replace`,
`overwrite`, `remove`, or `move`. Only `replace` requires `expectedSha256`;
removal and movement carry it when acting on a capture. Shell operations may
omit that guard, but still require a source, and moves require an empty
destination. There is no sentinel union mixing hashes with `'absent'` or `'any'`.

`list()` inventories the whole folder; `children(directory)` lists one level
and accepts `''` for the root. `open(path)` returns a stable `Blob` for
consumption, without holding a file descriptor. `mkdir(path)` creates missing
parents; `rmdir(path)` removes an empty directory. These directory operations
do not request history through the file publisher.

### Tables own only their row files

A table reads and writes one Markdown file per row. A file that shares a
row's stem, such as `recordings/take.webm` beside `recordings/take.md`, is an
ordinary file. It is not part of the entry, does not block creating the row,
and stays where it is when the row is renamed or deleted. An application that
keeps media records the path in a field or a Markdown link and manages those
files through `files`. Nothing scans references, repairs links, or collects
unreferenced files.

`update(stem, change)` reads current source once and patches it: it replaces only the touched frontmatter
value spans or appends new keys, and refuses rather than rewriting YAML it
cannot patch safely. Comments, quoting, key order, unknown keys, a byte-order
mark, and CRLF line endings survive. `replace` writes the supplied text
exactly, so invalid frontmatter can be saved and repaired. A row whose
frontmatter cannot be interpreted stays a readable entry with `issues`.
`patchSource` and `readSource` are exported for editors that keep their own
buffer.

Every entry carries `stem`: its filename without the exact lowercase `.md`,
taken literally. `entry.path === rowPath(table.name, entry.stem)`, and
`rowStemOf(table.name, path)` is the inverse for code that holds only a path;
it returns `undefined` for a path that is not a row of that table. `create`
and `rename` apply the naming rules (`stemProblem`) to the name they make.
`get` and `update` do not: a row another program saved as `todos/bad .md` or
`todos/.md` has the stem `'bad '` or `''`, reports a `filename` issue, and is
read and edited at that stem. An empty stem is an address, so compare a stem
with `undefined` or `''` explicitly rather than by truthiness.

`get` refuses a stem containing a path separator, and entry operations refuse
a nested path such as `todos/a/b.md`.

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
the collected bytes and from a moved file's captured hash, never from a
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

### Editor policy

The application chooses its local buffer, save trigger, and response to incoming
content independently. A checkbox can submit immediately and display confirmed
data until success. A title input can bind to local state and save on blur,
debounce, or an explicit action. A document can keep a complete-source buffer.
The folder requires no timer, UI binding, or shared editor controller.

An application may replace local input whenever it reads external content,
refresh only while clean, or keep its local draft. Following external content
while typing can discard unsaved input. Keeping a draft does not choose its
save condition: `files.replace(capture, source)` refuses changed content, while
`files.overwrite(path, source)` deliberately replaces whatever is there.
An application offering review can compare its baseline, latest observation,
and draft before conditionally saving against the reviewed capture.

`tables.<name>.update(stem, { fields?, body? })` reads the current row and
patches only the requested fields/body. Changes saved before that read survive
when they concern other parts. A race after the read returns `Conflict`;
there is no automatic retry. A missing row returns `NotFound` and is never
created by an update. The caller may inspect `error.name` and decide what to do.

For `update`, `NotFound` means the row was absent at its initial read;
`Conflict` means the publication condition failed, including removal between
read and save (`actual === undefined`). `Unconfirmed` means the outcome is
unknown. These are common outcomes, not the entire error union: validation,
unsupported source, and I/O can also fail. No outcome triggers automatic replay.

`replace(entry, source)` saves complete text against the entry's captured
baseline. It uses the entry's path, accepts invalid frontmatter for repair,
and returns an entry interpreted from the submitted bytes. It does not merge
fields, normalize text, or reread afterward. Neither method mutates captured
entries; each returns a new one on success.

An entry is already a file capture, so `files.replace(entry, source)` also
works. The table helper additionally checks row membership and returns parsed
fields, body, and issues for the submitted text. The raw file helper returns
only the new capture. Neither requires a separate path argument.

A successful receipt describes the submitted content, not newer typing or a
later observation. An `Unconfirmed` result leaves the operation's outcome
unknown; an unchanged read does not prove cancellation. UI policy may discard
input, but it cannot claim that an uncertain publication definitely failed.
See [application editor policies](../../docs/adr/0485-applications-choose-editor-observation-and-save-policies.md).

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
`commitOnEdit: false`. A command holds nothing between its steps, in the
browser or the desktop app: another tab's or window's save can land between
them, and a command that stops partway leaves its earlier steps saved. Each
save follows the folder's automatic history policy. The terminal ends with
the folder: closing stops a running command at its next step.

The filesystem adapter maps reads to `storage.read`, file mutations to
`storage.apply`, and directory changes to `storage.mkdir` and `storage.rmdir`.
File and directory metadata share an inventory read at command start and
refreshed after the command's own changes and a successful Git pull. Reads
fetch current bytes. Append reads the destination before saving, uses exclusive
creation for a missing file, and replaces an existing file conditionally.
Binary pipelines and redirection preserve bytes. Recursive copies preserve
empty directories; directory moves relocate captured paths without reading
file contents. A file added to the source during a move stays there and can
prevent the source directory from being removed.

This is a virtual filesystem over literal Folder entries. Move destinations
must be unoccupied, including directory destinations; moves refuse existing
files instead of overwriting them. Content writes and directory moves can
create missing parent directories. Permissions and timestamps are synthetic,
and entry identity does not expose native hard-link aliases.

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
cancels pushes and fetches. It does not await file helpers or publication
replies. Await a save that must finish before closing:

```ts
const saved = await folder.files.create('note.md', 'Saved before leaving');
if (saved.error) return show(saved.error.message);
await folder.close();
```

A helper still reading or hashing can be refused at its next storage call. An
already-started application returns its actual Result, including `Partial` or
`Unconfirmed`. Closing never relabels that outcome. A browser transaction can
finish after close returns, although its cross-tab hint can be lost once the
notification channel closes.

A Git request still waiting for admission is refused; work that already
entered its protection
settles before storage is released. No final commit is required, and saved
files can remain uncommitted after close.

In the desktop app, closing detaches this page. The owner keeps the folder,
finishes operations it already accepted, the commit, and any push or fetch it
had already started for the page, and serves every other window. A push or fetch of the page that
the owner had not started is withdrawn and never starts. The owner makes no
commit because a page closed or the app quit: a save whose attempt was skipped
stays uncommitted there too.

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


## Internal composition

Files, tables, KV, batches, and the terminal use one storage API. Its `apply`
accounts for content changes, so a domain method cannot accidentally choose a
write that skips history or change hints.

```ts
createFiles({ storage })
createTable({ storage }, definition)
createKv({ storage }, { definition })
createTerminal({ storage, git }, options)
```

Browser and Bun openers wrap raw storage with publication accounting. The
Tauri owner already performs that accounting. Assembly fences the resulting
storage with the handle's close signal. These wrappers retain no file-operation
collection.

Git keeps raw storage because incoming fast-forwards update files and history
under their own policy. They must not trigger an automatic commit as a new
local save. A batch uses one `apply`. Terminal writes apply separately; a
recursive removal or directory move applies its captured file steps together.
