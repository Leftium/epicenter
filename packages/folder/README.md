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
const listed = await folder.tables.todos.list();       // one { path, result } per row file
const created = await folder.tables.todos.create({ fields: { title: 'Milk', done: false } });
await folder.tables.todos.update(created.data!.stem, { fields: { done: true } });
await folder.close();
```

## Dataset names, definitions, and addresses

A folder ID names a dataset relative to its owner. In the managed native layout,
`so.epicenter.todos` names `local/so.epicenter.todos/` or
`accounts/<account-key>/so.epicenter.todos/` under the selected Epicenter root.
Reverse-DNS names provide a shared convention for compatible tools. A name such
as `so.epicenter.todos.work` denotes another dataset in a literal sibling
directory; dots do not create nested directories or inherited permissions.

A definition describes how this tool reads and edits the folder's files.
Its required `id` supplies a convenient default folder ID. It is not a schema
fingerprint or an exclusive claim by an application. Different tools can use
different definitions to interpret the same files. Compatible field meanings
still matter when those tools write to the same dataset.

```ts
const personal = await openFolder({ definition });
const work = await openFolder({ definition, id: 'so.epicenter.todos.work' });
```

Both openings use the same interpretation at different addresses. Supplying
`id` at opening keeps dataset selection separate from the reusable definition.
An application can open several datasets, and several compatible applications
can reach the same dataset. Its app ID and private SQLite namespace are separate
choices even when they use the same default string.

The complete managed address includes the channel, owner, and folder ID.
Browser storage also belongs to one origin. Opening captures the address for
the handle's lifetime; signing in later does not move its data or retarget its
writes. Browser callers select `browser.scope`; a native shell registers the
selected directory. The Bun opener instead receives an explicit directory.
The managed native layout is described in
[ADR-0461](../../docs/adr/0461-portable-data-folders-live-under-local-and-derived-account-scopes.md).

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
  browser,   // optional: { scope, author, remote, commitOnEdit, indexedDb }
}): Promise<Result<Folder, OpenFolderError>>
```

`browser` applies to a browser folder only. A browser folder commits under a
local author by default and commits each save automatically; a `remote` needs
an explicit `author`. In the desktop app the shell owns the directory, the
author, the remote, and the history policy. The policy in effect is on
`folder.git.snapshot` either way.

Browser storage ownership can be supplied explicitly:

```ts
openFolder({
  definition,
  browser: { scope: { channel: 'development' } },
});
// For an account: scope: { channel: 'release', account }
// account is the captured { authorityId, principalId }, without credentials.
```

The browser derives database, Web Lock, and notification names from the same
captured channel, scope, account key, and folder ID. Later login changes do not
retarget an open handle. Omitted scope and explicit release Local keep the
established names and reopen existing bytes and history. Development and
account scopes use a separate namespace; they do not change private app SQL.

If the scoped database is absent but an old unscoped folder exists, opening
returns `LegacyScopeUnassigned` before creating a replacement. Existing scoped
databases can reopen. The package does not infer which account owns legacy
data, move it, or provide a migration UI. Opening a new scope requires
IndexedDB database enumeration; unavailable enumeration returns `Unavailable`.
Apps must choose their scope explicitly; existing callers are not automatically
switched to development or account storage.

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
| `tables.<name>` | Rows at `<name>/<stem>.md`. A snapshot is the captured file: its path, literal `stem`, exact `source`, and `sha256`, beside how that text reads: `fields`, `body`, `parseError`, and `issues`. `get(stem)` returns `undefined` only for absence. `list()` returns one `{ path, result }` for every row file. `inspect(source)` interprets text without reading anything. `create` is exclusive. `update(stem, change)` reads current source once and conditionally publishes without retry. `replace` and `delete` take a file capture; `rename` takes a text capture. They refuse if the file changed. Each changes exactly one Markdown file. See [Reading a row](#reading-a-row). |
| `kv` | Root `kv.json`, a sparse map of declared values. A snapshot is a text capture: `path`, exact `source`, and `sha256`, beside the stored `values` that validated, `parseError`, and `issues`. `get()` returns `undefined` only for absence; readable text that is not a JSON object is a snapshot with a `parseError`. `inspect(source)` interprets text without reading anything. `create(values)` saves a new file from the supplied values and refuses with `Exists` when one is there. `update(values)` reads current source once, assigns the supplied keys, and conditionally publishes without retry; a missing file is `NotFound`. An update changes only the values it assigns: unknown keys, number spellings, and formatting stay exact. See [Reading and saving kv.json](#reading-and-saving-kvjson). |
| `files` | Ordinary files at literal paths. See below. |
| `batch(collect)` | Several mutations in one application with one history request. See below. |
| `git` | A status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, `mergeIncoming()` and `mergeUnsupported`, and `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
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
capture; the one passed in stays what it was. A table snapshot is a capture of
its row file, a KV snapshot is a capture of `kv.json`, and so is a `read`
result.

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
ordinary file. It is not part of the snapshot, does not block creating the row,
and stays where it is when the row is renamed or deleted. An application that
keeps media records the path in a field or a Markdown link and manages those
files through `files`. Nothing scans references, repairs links, or collects
unreferenced files.

### Reading a row

Reading a file and interpreting its text are separate, and so are a text that
does not parse and a field that does not conform (ADR-0462).

```ts
const { data: todo, error } = await folder.tables.todos.get(stem);
if (error) return showReadFailure(error);              // the file could not be read as text
if (todo === undefined) return showMissing();          // only absence

showSource(todo.source);                               // the repair baseline, parsed or not
if (todo.parseError) return showParseFailure(todo.parseError);
showIssues(todo.issues);                               // always an array
if (typeof todo.fields.done === 'boolean') showCheckbox(todo.fields.done);

const draft = folder.tables.todos.inspect(buffer);     // the same reading of unsaved text
```

One Result says whether the file was acquired. The snapshot is flat: there is
no second Result to go through for its fields.

| Outcome | Where it is | What it carries |
| --- | --- | --- |
| The file is absent | `get`: `Ok(undefined)`. A `list` item whose file went away after it was enumerated: that item's `NotFound`. | Nothing. |
| The file could not be read as text | The outer `Err` of `get`, or one `list` item's `Err`: an inadmissible address, a directory at the path, I/O, a closed folder, or `InvalidUtf8`. | No source. Raw bytes may still be readable through `files`. |
| The text does not parse | `snapshot.parseError`, with a `message` and one or more `diagnostics`. | `fields` is empty, `body` is `undefined`, and `issues` is empty. `source` is the whole text. |
| The text parses | `snapshot.parseError` is `undefined`. | `body` is the text after the closing fence, possibly empty. `fields` holds every declared field that validated by itself. `issues` names each declared field that is missing or does not conform, and is empty when none is. |

`fields` is always partial. An empty `issues` does not turn it into a
complete row, so code checks the fields its action needs: a checkbox needs a
valid `done`, not proof that every other field conforms. A declared field the
source lacks is an issue, a nullable one included: a stored `null` is a
value, and a key that is not there is not. No default stands in for it.

Field values, issues, and parse errors are frozen at every depth, so a
snapshot cannot come to disagree with its `source` and `sha256`. The
`DeepReadonly` type says the same thing, and leaves a branded string such as
an `InstantString` as it is. A snapshot holds nothing open and has no
methods; it stays readable after the folder closes.

Row source is an opening `---` line, a YAML mapping with string keys, a closing
`---` line, and a body. A byte-order mark may come first, and lines may end in
LF or CRLF. An empty or comment-only block is an empty mapping, and the body
may be empty. Anything else fails parsing as a whole: text with no opening
line, an opening line with no closing line, invalid YAML, a repeated key, a
sequence or scalar where the mapping belongs, a key that is not a string, and
an alias that cannot be resolved, is circular, or expands past a fixed bound.
Markdown without fences is not read as a body, and nothing inserts fences
into it.

After parsing, each declared field is checked by itself against its prepared
schema.
A key the table does not declare stays in the source and is not an issue.
Nothing is coerced, defaulted, or repaired. An issue has `field`, `message`,
and, when the validator names a location inside the field's value, a JSON
pointer `path` such as `/1` for the second item of a list. Messages and the
number of issues or diagnostics are for people, not for code to match on.

`list()` returns one item for every `.md` file directly in the table's
directory, in no promised order. Text that does not parse is a successful
item whose snapshot has a `parseError`, so presence, selection, and repair
all use the same listing. A file that could not be read is that item's error
and no snapshot is invented for it. The outer `Err` means the listing itself failed, and no
partial listing is returned. A table directory that does not exist lists as
empty.

`inspect(source)` is synchronous and reads nothing. It returns the reading by
itself, `{ fields, body, parseError, issues }`: no path, no hash, and no
Result. Reads, save receipts, and an editor checking its unsaved buffer get
the same answer for the same text, so a draft's diagnostics describe the
draft and never a saved file.

### Names

Every snapshot carries `stem`: its filename without the exact lowercase `.md`,
taken literally. `snapshot.path === rowPath(table.name, snapshot.stem)`, and
`rowStemOf(table.name, path)` is the inverse for code that holds only a path;
it returns `undefined` for a path that is not a row of that table, including
`a.MD`, which is an ordinary file.

A stem is one literal filename segment. Nothing trims it, folds its case,
normalizes its Unicode, or strips an extension, and no rule about names that
other systems cannot store applies to `create`, `rename`, `get`, or `update`.
`'bad '`, `'.hidden'`, `'a: b'`, and the empty stem (`todos/.md`) are
addresses like any other, and a name is never a diagnostic. An empty stem
is an address, so compare a stem with `undefined` explicitly rather than by
truthiness.

What is refused is what any path in the folder is refused for: a stem with a
path separator, a backslash, or a control character is `InvalidPath`, as is
a capture at a nested path such as `todos/a/b.md`. Whether a name can be
stored, and whether two spellings are one file, is the backing storage's
answer. Browser storage keeps names exactly, so `Plan` and `plan` are two
rows. A directory on a filesystem that holds one file for both refuses the
second with `Exists`, because its exclusive create found the name taken.
Incoming history has its own rule and may refuse paths a filesystem could not
hold apart; see Incoming changes.

### Saving a row

`create` always writes both fences, so a row with no fields and no body is
`---\n---\n`. `create` and `rename` read the table directory once before
publishing and refuse a destination a file already has, at that exact name,
with the files' `Exists` error; the publication then requires the destination
to be empty, which is also where a filesystem refuses a second spelling of a
name it holds as one file.

`update(stem, change)` checks the supplied values, reads current source once,
and patches it: it replaces only the touched frontmatter value spans or
appends new keys. Comments, quoting, key order, unknown keys, a byte-order
mark, and CRLF line endings survive. Fields the update does not assign may
have issues; that does not block it. The current source must parse, even to
change only the body. Nothing is rewritten on a refusal.

`replace` encodes complete supplied text as UTF-8, so text that does not parse
can be saved and later repaired. That save succeeds: the result is `Ok(snapshot)`
with a `parseError`.

`create`, `update`, `replace`, and `rename` return the snapshot of the bytes
they submitted, with their hash. Nothing is read back, and the capture that
was passed in never changes. The receipt reads the text those bytes decode
to. It is not the string that was passed, where encoding replaced an
unpaired surrogate, and its fields are never the objects that were supplied.
The receipt is interpreted and prepared before publication, so returning it
after successful publication needs no further validation. Storage still reports
partial or uncertain outcomes through its operation error. What the text reads
as does not decide whether it is saved: text that does not parse, and text with a field that does
not conform, are saved by `replace` all the same. A field whose validator or
refinement throws on a stored value is a field that does not conform: it is
left out with an issue, and the other fields and the body are still read.

`rename` submits no bytes, so its receipt reads the `source` of the capture it
was given. That source must encode to the capture's `sha256`; a capture whose
source and hash disagree is refused before anything is read or moved.

`create` and `update` copy the values they are given when they are called.
They accept readonly values, so a field taken from a snapshot goes back in
without a cast, and they never freeze or keep the caller's objects. The copy
is made and frozen before the field is checked, so a refinement is shown the
folder's own value, parsed or copied, and never an object the caller holds.
A refinement may freeze what it is shown. One that changes it is a field that
does not conform: an issue in a reading, `InvalidValues` for a supplied value.
A value that is not JSON, such as a class instance, is refused as it is and
never copied into a plain object. The same holds for what YAML can spell and
JSON cannot, such as `!!binary` bytes, a date, or `.inf`: under a declared
field it is an issue and the other fields and the body still read, and under
an undeclared key it stays in the source unreported.

| Refusal | Error | Wrote anything |
| --- | --- | --- |
| A supplied value is undeclared, does not conform, is missing from a new row, or cannot be copied or written as YAML | `InvalidValues`, with `issues` | No |
| The stem or capture does not address a row in this folder, or a `rename` capture's source is missing or is not the text of its hash | `InvalidPath` | No |
| `create` or `rename` found the destination taken | `Exists` | No |
| `update` found no row at its read | `NotFound` | No |
| `update` read source that does not parse | `Unparsed`, with the parse `error` | No |
| `update` read source that parses but cannot be patched without changing source it was not asked to change: an anchor, alias, or tag on the value, or a flow mapping | `UnsupportedSource` | No |
| The file changed, or went away, before publication | `Conflict` | No |
| Storage failed | `Io` | No |
| A rename on disk stopped between its two steps | `Partial` | Yes: the destination holds the bytes |
| The desktop owner's reply was lost | `Unconfirmed` | Unknown |

Each method's error type adds its own preparation failures to the shared storage family: `TableGetError`,
`TableEnumerationError`, `TableReadError` for one listed file,
`TableCreateError`, `TableUpdateError`, `TableReplaceError`,
`TableRenameError`, and `TableDeleteError`. `TableWriteError` is their union
for code that presents any save failure alike.

`patchSource` and `frameSource` are exported for editors that keep their own
buffer. `patchSource` has the same refusals as `update`, as `unparsed`,
`value`, and `unsafe`; it checks no table fields.

### Reading and saving kv.json

`kv` is one fixed root file holding a sparse map of declared values. It uses
the same two diagnostics as a row (ADR-0487).

```ts
const { data: snapshot, error } = await folder.kv.get();
if (error) return showReadFailure(error);              // handle this before any default
const kv = { ...KV_DEFAULTS, ...(snapshot?.values ?? {}) };
showDiagnostics(snapshot?.parseError, snapshot?.issues ?? []);
```

| Outcome | Where it is | What it carries |
| --- | --- | --- |
| The file is absent | `get`: `Ok(undefined)`. | Nothing. No capture is invented. |
| The file could not be read as text | The `Err` of `get`: I/O, a directory at the path, a closed folder, or `InvalidUtf8`. | No source. |
| The text is not one JSON object | `snapshot.parseError`. | `values` is empty and `issues` is empty. `source` is the whole text. |
| The text is a JSON object | `snapshot.parseError` is `undefined`. | `values` holds every stored declared value that validated by itself. `issues` has an entry for each stored value that does not conform. |

The format is one strict JSON object, after an optional byte-order mark.
Comments and trailing commas fail parsing. A root key that appears twice
reads as its last value, as `JSON.parse` reads it.

A declared key the file does not have is left out of `values` and is not an
issue. An undeclared key stays in the source and is not reported. Values live
under `values` so a declared key named `source` or `issues` cannot collide
with the capture. Values and diagnostics are frozen at every depth.

The folder has no defaults. `get`, `inspect`, preparing the definition, and
opening the folder insert nothing and save nothing. An application applies
its own defaults where it derives its state, as above: a missing file, a
missing key, and a stored value that was left out all fall back, and a stored
`null` does not. The merge is one level deep.

`inspect(source)` is the same reading of text that was not saved:
`{ values, parseError, issues }`, with no path, hash, or Result.

`create(values)` checks the supplied values and saves a new file without
reading; an existing file is `Exists`. `update(values)` reads current source
once, assigns the supplied root keys, and replaces what it read. Both copy
the supplied values when they are called, accept readonly values such as a
snapshot's, and leave the caller's objects as they were. A receipt is the
snapshot of the submitted source and its hash, with nothing read back. An
update is not an upsert: it never creates the file.

| Refusal | Error | Wrote anything |
| --- | --- | --- |
| A supplied key is undeclared, or its value does not conform, is over the nesting or width budget, or does not read back from JSON as supplied | `InvalidValues`, with `issues` | No |
| `update` found no file at its read | `NotFound` | No |
| `update` read text that is not one JSON object | `Unparsed`, with the same parse `error` a read reports | No |
| `update` read an object it cannot assign in safely: a supplied key appears more than once | `UnsupportedSource` | No |
| The file changed, or went away, before publication | `Conflict` | No |

A file can therefore read with valid values while one update of it is
refused. Unknown keys are left exactly as written, repeated ones included.
Repair the complete text with `files.replace(snapshot, source)`. That returns
a raw capture; call `kv.inspect` on the text that was submitted to see how it
reads. `KvReadError` and `KvWriteError` are the two error unions.

### Merging kv.json

`mergeKv({ base, ours, theirs })` reconciles three captured sources without
opening a folder. Each input is a JSON object string or `null` for a missing
file. Rust exposes the equivalent `kv_merge::merge_kv(base, ours, theirs)` in
`epicenter-folder-core`. Both implementations run the same fixtures.

For each root key, equal choices agree; a side unchanged from the base yields
to the other side. Competing changes return `kind: 'conflict'` with each key's
raw base, ours, and theirs values. Nested objects and arrays stay together as
one value. A missing key differs from a stored JSON `null`. Deleting the file
conflicts with a change to its values and returns `kind: 'file-conflict'`.

A successful result has `kind: 'merged'` and `source`, which is `null` for a
deleted file. It preserves selected value text and regenerates root formatting
with sorted keys. Object key order and string escape spelling do not affect
equality. Number tokens compare exactly, so `1` and `1.0` differ; large unknown
numbers never round through JavaScript. Equal values choose the same raw text
when ours and theirs swap.

Malformed JSON, duplicate keys at any depth, unpaired Unicode surrogates, and
nesting beyond 64 containers return `kind: 'invalid'` and the first invalid
`side` in base, ours, theirs order. A leading BOM is accepted and removed from
output. Callers must decode bytes without replacing invalid UTF-8.

The function does not apply field schemas, write files, or choose a winner for
competing edits. A browser folder's `git.mergeIncoming()` uses it for root
`kv.json`; see [Merging incoming changes](#merging-incoming-changes).

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
- A batched row's destination is looked for before anything is published: a
  file already at that exact path is `Exists`, and the whole batch is
  refused. The table directory's names are listed once, then the plan is
  walked in order, so a row may take a name that an earlier step of the same
  batch removed or moved away, and two collected rows at one path are
  refused. Names are compared exactly. The check is best effort against other
  programs writing the directory, and each creation still publishes only into
  an empty destination.

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
read and save (`actualSha256 === undefined`). `Unconfirmed` means the outcome is
unknown. These are common outcomes, not the entire error union: see
[Saving a row](#saving-a-row). No outcome triggers automatic replay.

`replace(snapshot, source)` saves complete text against the snapshot's
captured baseline. It uses the snapshot's path, accepts text that does not
parse, and returns a snapshot of the submitted bytes with how they read. It
does not merge fields, normalize text, or reread afterward. Neither method
mutates a captured snapshot; each returns a new one on success.

A snapshot is already a file capture, so `files.replace(snapshot, source)`
also works. The table helper additionally checks row membership and returns
the reading of the submitted text. The raw file helper returns only the new
capture. Neither requires a separate path argument.

An editor checks its unsaved buffer with `inspect(buffer)`. It should not mix
that with the saved snapshot's reading: the two describe different text.

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
exclude; private Git state is never source. SQLite filenames have no special
exclusion: an intentionally saved database follows ordinary Git rules. Plain Git
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

A browser publishes files, index, and branch in one transaction. Inside it,
every portable file must still have the hash the update captured, no new file
may have appeared, and the index must be the bytes its clean check left;
otherwise nothing is written and the update is `Refused` or `StagedChanges`.
A folder on disk applies ordered file steps, updates the index, and moves the
branch last; a failure reports the steps that completed, marks the saved-files
observation stale, and requests no commit.

### Merging incoming changes

`mergeIncoming()` applies the fetched remote head when histories diverged. It
pins the branch head and the fetched head, requires the same clean folder as
`pullFastForward()`, and refuses the same incoming commits. A branch that is
behind fast-forwards; a branch that is ahead or equal changes nothing. It
never pushes, and `pullFastForward()` still refuses divergence.

Diverged histories need exactly one merge base; none or several is
`UnsupportedHistory`. The merge writes one commit whose parents are the pinned
head and the pinned fetched commit, and publishes its files, a clean index,
and the branch in one transaction.

- Root `kv.json` changed on both sides merges by key with `mergeKv`, and is
  saved with sorted keys. A nested `kv.json` is an ordinary file.
- Every other path follows Git's rules through isomorphic-git's merge.
  Unchanged, identical, and one-sided changes keep their exact bytes.
- A file both sides changed merges by lines only when all its versions are
  UTF-8 with no NUL byte and no line break the line merge would drop: a lone
  carriage return, U+2028, or U+2029. isomorphic-git 1.38.5 would otherwise
  replace bytes, so such a file is a `binary` conflict.
- A `merge` attribute other than Git's default on such a file is
  `Unmergeable`, as is a link, executable, or submodule among its versions.

Competing changes are `Conflicted`, with one entry per reason: `kvKey` with
the raw base, ours, and theirs values of the key; `kvFile` when one side
deleted `kv.json` and the other changed it; `kvInvalid`; `content` for
competing lines; `binary`; `deleted` for a delete against a change; and
`shape` for a file against a directory. A conflict or refusal writes no file,
index entry, or ref; unreachable objects may remain.

Only a browser folder merges. In the desktop app and a directory folder,
`mergeUnsupported` says why and `mergeIncoming()` returns `Unsupported`
without sending or changing anything.

A whole-folder commit or fast-forward on disk writes every file as plain
`100644` bytes, so it is refused in a repository it would misrepresent:
symbolic links, executables, submodules, nested `.git` data, `core.autocrlf`,
or a normalizing attribute on a source file. Reads and file saves still work.

## Declaring a folder

`defineFolder` checks the definition where it is written. `defineTable` and
`field` are the vocabulary every Epicenter storage shares
(`@epicenter/definition`). A field is any native TypeBox schema; the `field.*`
helpers build common ones. A folder refuses a table that declares a body
conversion, because a row's body is the file's Markdown text. An opener given
such a definition returns `InvalidDefinition` before it acquires anything.

`defineFolder` returns the prepared definition. It has the shape and type of
what was declared: `kv` and each table's `fields` are records of native
schemas, and a table's key is its name. Each schema is an owned, frozen
snapshot, so editing a schema after `defineFolder` changes nothing an opened
folder accepts. An opener handed any other declaration prepares it first and
reads the snapshot.

A field's editor hint decides nothing about what a folder stores.
`field.reference('lists')` is a nonempty string whose hint names a table. The
folder does not check that the table or the row exists, and renaming or
deleting a row rewrites nothing that names it, so a stored identifier may
dangle.

## Layout

| Path | What it is |
| --- | --- |
| `src/contract.ts` | Everything an application names besides the opener. Every entry exports it unchanged. Loads no storage, Git implementation, or runtime module. |
| `src/index.ts`, `browser.ts`, `tauri.ts`, `bun.ts` | The entries. |
| `src/browser-adapter.ts`, `tauri-adapter.ts` | The adapters the automatic entry loads lazily. |
| `src/folder.ts`, `table.ts`, `kv.ts`, `batch.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter. |
| `src/reading.ts` | The diagnostics a table and KV reading share: `ParseError`, `FieldIssue`, `DeepReadonly`, and the ownership every checked value has: parsed values frozen and supplied values copied before a field sees them. |
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

A reference field has no integrity: nothing checks its target, and rename
repairs no references. `kv.update`
writes each value it assigns as compact JSON. Browser bytes are stored whole, and every commit
or status check reads the whole folder. Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.


## Internal composition

Files, tables, KV, batches, and the terminal use one storage API. Its `apply`
accounts for content changes, so a domain method cannot accidentally choose a
write that skips history or change hints.

```ts
createFiles({ storage })
createTable({ storage }, name, definition.tables[name].fields)
createKv({ storage }, definition.kv)
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
