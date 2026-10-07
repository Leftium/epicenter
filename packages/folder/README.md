# @epicenter/folder

A folder whose current files are the saved data: Markdown rows, `kv.json`, and
any other file, with Git history beside them. There is no document store
behind it. The package does not depend on `@epicenter/app`.

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  kv: { theme: field.string() },
  tables: {
    todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }),
  },
});

const { data: folder, error: openError } = await openFolder({ id: 'so.epicenter.todos', definition });
if (openError !== null) return show(openError.message);

const stop = folder.onFilesChanged(() => refresh());   // subscribe, then read
const listed = await folder.tables.todos.list();       // one { path, result } per row file
const { data: created, error: createError } = await folder.tables.todos.create({
  fields: { title: 'Milk', done: false },
});
if (createError !== null) show(createError.message);
else {
  const { error: updateError } = await folder.tables.todos.update(
    created.stem,
    { fields: { done: true } },
    {},                                                // the current row; { expectedSha256 } for reviewed bytes
  );
  if (updateError !== null) show(updateError.message);
}
await folder.close();                                  // closed either way
```

## File-browser helpers

`@epicenter/folder/file-browser` provides path helpers, visible tree rows,
newline preservation, and `readTextFile(files, path, maxBytes)`. These helpers
open no storage and change no files. Apps supply their editable-byte limit and
keep their own file-name messages. Text classification preserves the file's
byte-order mark; invalid UTF-8 and NUL bytes open as binary details.

`submittedText(text)` from the main contract returns the bytes a save submits
and the exact text of those bytes. Row writes and app text editors use the same
encoding rule, including replacement of unpaired surrogates.

## Dataset names, definitions, and addresses

A folder ID names a dataset relative to its owner. In the managed native layout,
`so.epicenter.todos` names `local/so.epicenter.todos/` or
`accounts/<account-key>/so.epicenter.todos/` under the selected Epicenter root.
Reverse-DNS names provide a shared convention for compatible tools. A name such
as `so.epicenter.todos.work` denotes another dataset in a literal sibling
directory; dots do not create nested directories or inherited permissions.

A definition describes how this tool reads and edits the folder's files. It
names no folder: `defineFolder` refuses an `id`, at the type and when it runs.
Different tools can use different definitions to interpret the same files.
Compatible field meanings still matter when those tools write to the same
dataset.

Each successful browser, Bun, or Tauri acquisition attempts to overwrite root
`definition.json` before returning. The file describes the opening application's
prepared `title` when present, `kv`, and `tables`, including portable validation
and editor hints. It contains no dataset identity or runtime resources. The JSON
uses two-space indentation, declared order, and a trailing newline. Opening
uses the application declaration; it never reads this file as configuration.

Publication replaces manual descriptions and descriptions from another app
version. It migrates no saved rows or settings. Unsupported export or a failed
write is logged through `wellcrafted/logger`, with the destination and actual
failure, while the folder remains usable. A failed attempt can leave discovery
missing, stale, or uncertain. For example, adding a runtime refinement can leave
an earlier version's description in place because that refinement cannot be
exported faithfully. See [portable export](../definition/README.md#what-survives-json).

Publication always writes through `files.overwrite`, including on unchanged
reopening. It uses `commitOnEdit`: opening awaits the file attempt while
history settles separately, and identical trees create no additional commit.
Publication never explicitly commits or pushes. Opening an empty folder before
pulling an existing remote changes bootstrap behavior: with history disabled,
the uncommitted `definition.json` blocks incoming updates; with history enabled,
its local initial commit creates unrelated history. Initialize a clone before
opening when that runtime provides a clone operation. The current Todos browser
startup opens first and requires a separate remote-bootstrap repair.

```ts
const personal = await openFolder({ id: 'so.epicenter.todos', definition });
const work = await openFolder({ id: 'so.epicenter.todos.work', definition });
```

Both openings use the same prepared definition at different addresses. The
browser and desktop openers require `id`, and refuse a missing one before they
acquire anything. An application keeps its usual folder ID beside the code
that opens it, not in the definition. An application can open several
datasets, and several compatible applications can reach the same dataset. Its
app ID and private SQLite namespace are separate choices even when they use the
same string.

The complete managed address includes the channel, owner, and folder ID.
Browser storage also belongs to one origin. Opening captures the address for
the handle's lifetime; signing in later does not move its data or retarget its
writes. Browser callers select `browser.scope`; a native shell registers the
selected directory. The Bun opener instead receives an explicit directory and
no folder ID.
The managed native layout is described in
[ADR-0461](../../docs/adr/0461-portable-data-folders-live-under-local-and-derived-account-scopes.md).

## Entries

| Import | Opens | Use it when |
| --- | --- | --- |
| `@epicenter/folder` | The desktop app's folder when the page runs in Tauri, this browser's storage otherwise. Decided when `openFolder` is called, and only the chosen adapter is loaded. | Ordinary application code. |
| `@epicenter/folder/browser` | This browser's origin private file system (OPFS) only. Refuses inside the desktop app. | A web-only build, or a test that injects an OPFS stand-in with `browser.opfs`. |
| `@epicenter/folder/tauri` | The desktop shell's folder only. Refuses outside it. | A desktop-only build. |
| `@epicenter/folder/bun` | An existing directory, in Bun. | Command-line tools, recovery scripts, and tests that are given a directory. |

The first three export the same `openFolder` signature and the same contract,
so one application source builds against any of them. Importing an entry opens
nothing. On a server, opening returns a refusal.

```ts
openFolder({
  id,        // required: which folder, such as 'so.epicenter.todos'. Never a path.
  definition,
  browser,   // optional: { scope, author, remote, httpFetch, commitOnEdit, opfs }
}): Promise<Result<Folder, OpenFolderError>>
```

`browser` applies to a browser folder only. A browser folder uses a local
author by default. Complete saves request automatic commits; requests made
before a checkpoint starts share it. A `remote` needs an explicit `author`.
`httpFetch` supplies a fetch-compatible HTTP function for Git fetch and push.
It defaults to regular fetch; applications can supply an authenticated relay.
It receives the canonical remote URL and the operation's abort signal. It does
not replace global fetch or change the stored remote. Credentials belong to
the transport, outside the folder's files and Git configuration.
In the desktop app the shell owns the directory, the
author, the remote, and the history policy. The policy in effect is on
`folder.git.snapshot` either way.

Browser storage ownership can be supplied explicitly:

```ts
openFolder({
  id,
  definition,
  browser: { scope: { channel: 'development' } },
});
// For an account: scope: { channel: 'release', account }
// account is the captured { authorityId, principalId }, without credentials.
```

The browser derives the folder's directory, its Web Lock names, and its hint
channel from the same captured channel, scope, account key, and folder ID.
Later login changes do not retarget an open handle. Omitted scope and explicit
release Local open `Epicenter/local/<id>`; development uses `Epicenter Dev/`,
and an account `accounts/<account-key>/` in place of `local/`. A folder ID or
account key is one directory name: `/`, `\`, `%`, and control characters are
escaped, so distinct IDs stay distinct directories. Development and account
scopes do not change private app SQL.

A scoped folder starts beside the release Local folder of the same ID and
never reads it. The package does not infer which account owns Local data,
move it, or provide an assignment UI. Apps must choose their scope
explicitly; existing callers are not automatically switched to development
or account storage.

A desktop page whose folder cannot be opened (no plugin, no permission, an
unregistered ID, another protocol version, a folder another process holds)
gets that refusal. It is never given browser storage instead.

### Browser storage

A browser folder is one OPFS directory. Each literal path is one stored file,
each directory, empty ones included, is one stored directory, and `.git` in it
is the folder's private Git state: no path can name it and no listing shows
it. There is no inventory beside the files: a file's identity is the SHA-256
of the bytes read from it, so a same-size rewrite in the same millisecond is
still a change. `open(path)` returns a Blob of the bytes read, which keeps
them after the path is replaced.

Opening requires `navigator.storage.getDirectory`, writable file streams, and
Web Locks; without one it returns `NoFileSystem` and never falls back.
IndexedDB is not required and is never read or written. A folder an earlier
version kept in IndexedDB is not opened, copied, or removed.

Every file mutation holds the folder's files Web Lock, so the conditions of
`create`, `replace`, `remove`, and `move` are checked and published without
interleaving across tabs. Reads take no lock. New bytes publish when a file's
stream closes, so a reader sees the old bytes or the new ones; a new file is
visible, empty, from its creation until its stream closes.

| What happened | Outcome |
| --- | --- |
| A step failed before its stream closed | `Io`. A file the step created is removed again; when its absence cannot be established, `Unconfirmed`. |
| A stream's close threw | `Unconfirmed`, whatever the path holds afterward: matching bytes do not prove which write put them there. The path is hinted, the history observation turns stale, and no automatic commit is requested. |
| A move landed its destination and could not remove its source | `SourceNotRemoved`. The destination is hinted. |

Saves are ordered by the lock alone, not by when their methods were called.
A save that hashes or waits longer can land after one asked for later, from
the same page or another, and whichever lands last on a path stays. A save
that must not overwrite bytes its caller did not review names them with
`expectedSha256` and is refused as `Conflict` instead.

### Which directory is the folder

A directory is a folder only while its ready marker,
`.git/epicenter-folder.json`, names that folder's captured address. Opening
decides this under the address's open Web Lock, so two tabs never decide it
at once.

| The directory holds | Opening |
| --- | --- |
| A marker naming this address | Opens it. Other properties the marker records are kept and ignored. |
| Nothing (or it does not exist), or only an empty `.git` with at most an empty marker | Writes the marker, then opens it. |
| A marker naming another address, or one that names none | `Unavailable`. |
| Anything else without a marker, or the path is not a directory | `Unavailable`. |

Identity refusals write nothing, so no marker is replaced and no unknown file is
adopted. A marker write that fails, or whose stream close is unconfirmed, is
`Unavailable` too, and no folder is started. Opening again starts over only
where the marker is absent or empty; a marker the close did publish opens,
and one naming another address stays refused.

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

Its replacements need a small Node-API addon, `addon/exchange.c`, on macOS
and Linux, built before the process runs:

```sh
bun run --filter @epicenter/folder build:addon
```

`scripts/build-addon.ts` compiles it with `$CC` (else `cc`) against the
`node-api-headers` development dependency into the ignored `addon/build/`;
it does nothing on other platforms. These package scripts run it first: `test`
here and in `apps/whispering`, `apps/capture`, `apps/todos`,
`apps/honeycrisp`, and `packages/capture`; `test:native` in
`apps/honeycrisp`; `native` in `apps/todos`; and `harness:recovery` in
`apps/capture`. Anything else, including `bun test` run directly and other
Bun tools, needs the command above first. Without a current build, a
replacement fails as `Io`, writes nothing, and names that command; it lands
once the build exists. An addon whose source cannot be read or whose build
cannot be loaded fails the same way with the actual cause, which rebuilding
may not fix. Nothing compiles at install time or at run time, and browser,
server, and desktop builds never load the addon or need a compiler.

## The handle

| Member | Contract |
| --- | --- |
| `tables.<name>` | Rows at `<name>/<stem>.md`. A snapshot is the captured file: its path, literal `stem`, exact whole-file `text`, and `sha256`, beside how that text reads: `fields`, `body`, `parseError`, and `issues`. `get(stem)` returns `undefined` only for absence. `list()` returns one `{ path, result }` for every row file. `create` is exclusive. `update`, `replace`, `rename`, and `delete` address the row by stem and take required options: `{}` acts on the current row, and `{ expectedSha256 }` is refused as `Conflict` when the bytes differ. `update(stem, change, options)` reads the current text once and conditionally publishes without retry. Interpreting text is `inspectRow(definition.tables.<name>, text)`, which needs no open folder. Each changes exactly one Markdown file. `edit(stem, { signal })` opens a retained canonical editor whose setters submit complete rows. See [Reading a row](#reading-a-row) and [Editing a row](#editing-a-row). |
| `kv` | Root `kv.json`, a sparse map of declared values. A snapshot is a text capture: `path`, exact `text`, and `sha256`, beside the stored `values` that validated, `parseError`, and `issues`. `get()` returns `undefined` only for absence; readable text that is not a JSON object is a snapshot with a `parseError`. `inspect(text)` interprets text without reading anything. `create(values)` saves a new file from the supplied values and refuses with `Exists` when one is there. `update(values)` reads the current text once, assigns the supplied keys, and conditionally publishes without retry; a missing file is `NotFound`. An update changes only the values it assigns: unknown keys, number spellings, and formatting stay exact. See [Reading and saving kv.json](#reading-and-saving-kvjson). |
| `files` | Ordinary files at literal paths. See below. |
| `git` | A status snapshot, `status()`, `commit()`, `commitAndPush()`, `push()`, `fetch()`, `pullFastForward()`, `mergeIncoming({ conflicts? })`, `recoverIncoming()`, and `paths()`, `stage()`, `commitStaged(message)`, `diff()`, `log()`. |
| `location` | `{ kind: 'opfs', directory }` or `{ kind: 'directory', root }`. For showing to a person. File paths are never joined onto it. |
| `onFilesChanged(listener)` | A hint that paths changed, so read again. Returns the function that stops listening. |
| `terminal({ cwd })` | A shell over the folder's files and history. |
| `signal`, `close()` | Closing fences the next storage call and stops network work. Git work drains before storage is released; file operations own their completion promises. It makes no final automatic commit. |

### Files

```ts
const { error: createError } = await folder.files.create('audio/take.webm', bytes);
if (createError !== null) return show(createError.message);         // refused if anything is there
const { data: file, error: readError } = await folder.files.read('notes/a.md');
if (readError !== null) return show(readError.message);             // file is { path, sha256, bytes }
const { data: next, error: replaceError } = await folder.files.replace(file, 'new text');
if (replaceError !== null) return show(replaceError.message);       // refused if it changed since
const { data: moved, error: moveError } = await folder.files.move(next, 'notes/b.md');
if (moveError !== null) return show(moveError.message);             // refused if either end changed
const { error: removeError } = await folder.files.remove(moved);
if (removeError !== null) return show(removeError.message);         // refused if it changed since
const { error: overwriteError } = await folder.files.overwrite('settings.txt', 'on');
if (overwriteError !== null) return show(overwriteError.message);   // whatever is there
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
- A moved file's capture is the captured hash at the new path. It is a
  receipt conditioned on that baseline, never a read of the destination:
  another program may write there afterward, and a directory's source check
  is best effort against outside programs. Read the file to know what it
  holds now.
- `create` reports `Exists` for an occupied path even when the bytes are identical.
- A stale capture is a `Conflict`. Nothing is merged, replayed, or retried.

Internally, the same intention reaches each backend as `create`, `replace`,
`overwrite`, `remove`, or `move`. `replace`, `remove`, and `move` carry an
optional `expectedSha256`; `files` always sends one, and a table sends one
when its caller's options name a baseline. Without the guard, each still requires a
file at its path or source: a `replace` never creates a file and is never sent
as an `overwrite`, and a move's destination must be empty. Browser OPFS, the
Bun directory, and the desktop owner enforce this where they publish. There
is no sentinel union mixing hashes with `'absent'` or `'any'`.

A `replace` requires its file when its bytes land, not only at a check
before, so a file another program removes is never put back: the save is
`NotFound`, or `Conflict` with no actual hash when guarded. The Bun directory
and the desktop owner exchange a staged file with the file in one system call
on macOS and Linux (and, for the desktop owner, iOS and Android), and a
filesystem there that cannot exchange fails the save as `Io`. The exchange is
the only operation on the path. If what it displaced is not a regular file,
or cannot be inspected, it stays where the exchange left it under
`.git/epicenter/scratch`: the save landed, and is reported as `Unconfirmed`
(a raw batch reports `Partial`) with a message that names that location.
Inspect the file, and anything written to it since, before restoring from
it. On Windows, and any other platform without an exchange, the Bun
directory and the desktop owner have no `replace` until a mechanism that
requires the file at publication is proven: the save is `Io` naming the
platform, the staged copy is removed, and this operation does not change the
destination. The caller keeps its input to copy or export; nothing retries.
Creation, reads, overwrites, moves, and removals are unchanged by this repair;
none is verified on Windows. Replace-based native suites are expected to fail
there with `Io`. The desktop owner has not been built for Windows. Browser folders, in any browser on any
operating system, are unaffected. OPFS opens the file without creating it
and checks again once its writable stream holds the lock that, in Chromium,
refuses removing the file or a directory above it; a Chrome 142 probe showed
that, and other engines are unverified. Bytes another program writes in that
last window are still replaced: the hash check stays best effort.

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
const { data: todo, error: readError } = await folder.tables.todos.get(stem);
if (readError !== null) return showReadFailure(readError); // the file could not be read as text
if (todo === undefined) return showMissing();          // only absence

showText(todo.text);                                   // the whole file: the repair baseline, parsed or not
if (todo.parseError) return showParseFailure(todo.parseError);
showIssues(todo.issues);                               // always an array
if (typeof todo.fields.done === 'boolean') showCheckbox(todo.fields.done);

const draft = inspectRow(definition.tables.todos, buffer); // the same reading of unsaved text
```

One Result says whether the file was acquired. The snapshot is flat: there is
no second Result to go through for its fields.

| Outcome | Where it is | What it carries |
| --- | --- | --- |
| The file is absent | `get`: `Ok(undefined)`. A `list` item whose file went away after it was enumerated: that item's `NotFound`. | Nothing. |
| The file could not be read as text | The outer `Err` of `get`, or one `list` item's `Err`: an inadmissible address, a directory at the path, I/O, a closed folder, or `InvalidUtf8`. | No text. `InvalidUtf8` carries the `sha256` of the bytes read, so a repair `replace` can be guarded by it. Raw bytes may still be readable through `files`. |
| The text does not parse | `snapshot.parseError`, with a `message` and one or more `diagnostics`. | `fields` is empty, `body` is `undefined`, and `issues` is empty. `text` is the whole file. |
| The text parses | `snapshot.parseError` is `undefined`. | `body` is the text after the closing fence, possibly empty. `fields` holds every declared field that validated by itself. `issues` names each declared field that is missing or does not conform, and is empty when none is. |

`fields` is always partial. An empty `issues` does not turn it into a
complete row, so code checks the fields its action needs: a checkbox needs a
valid `done`, not proof that every other field conforms. A declared field the
source lacks is an issue, a nullable one included: a stored `null` is a
value, and a key that is not there is not. No default stands in for it.

Field values, issues, and parse errors are frozen at every depth, so a
snapshot cannot come to disagree with its `text` and `sha256`. The
`DeepReadonly` type says the same thing, and leaves a branded string such as
an `InstantString` as it is. A snapshot holds nothing open and has no
methods; it stays readable after the folder closes.

Row text is the whole file: an opening `---` line, a YAML mapping with string keys, a closing
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
A key the table does not declare stays in the text and is not an issue.
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

### Interpreting and previewing text

`inspectRow(table, text)` and `serializeRow(table, draft)` take a table of the
definition `defineFolder` returned, so they work before `openFolder` and with
no storage. Both are synchronous; neither reads a file, hashes, or invents a
snapshot or capture.

Both take a `PreparedFolderTable`, a type only `defineFolder`'s return
carries, so passing a raw `defineTable` declaration is a compile error. The
mark exists only in types; at runtime the table is the same plain object. It
is not a proof of identity: it survives a spread, so a table rebuilt with
replaced or cloned `fields` still compiles, and reading a value through such a
field throws, as every read of an unprepared schema does. `serializeRow`
checks no value, so it does not notice. Keep the objects `defineFolder`
returned; a changed field or table needs `defineFolder` again. `openFolder`
still takes a raw declaration and prepares it.

```ts
const definition = defineFolder({ kv: {}, tables: { todos } });
const reading = inspectRow(definition.tables.todos, buffer);
const { data: preview, error } = serializeRow(definition.tables.todos, {
	fields: { title: draftTitle, done: false, tags: [] },
	body: draftBody,
});
```

`inspectRow` returns the reading by itself, `{ fields, body, parseError,
issues }`: no path, no hash, and no Result. Reads, a caller interpreting a
write receipt's `text`, and an editor checking its unsaved buffer get the same
answer for the same text, so a draft's diagnostics describe the draft and
never a saved file.

`serializeRow` returns the text `create` would write for draft values: both
fences, the declared keys present in declared order, then the body as given.
The text is that of its UTF-8 bytes, so an unpaired surrogate in the body is
already U+FFFD, as a save would submit it. It does not check values against
the schema: a value that does not conform is written all the same, and
`inspectRow` of the preview reports it, as it reports each declared field the
draft leaves out or sets to `undefined`. A value YAML cannot hold as supplied,
such as `NaN` or a `Date`, and an undeclared key are `InvalidValues`, since no
row could be saved with them. `create` still checks the schema and writes the
same text once the values conform.

A reading leaves out every key the table does not declare and every field
that did not conform, so serializing a reading is not a rewrite of the file
it came from. Change an existing row with `update`, with `patchRowText` on its
exact text, or with `replace` of edited text.

### Complete-document editing

`parseCanonicalDocument(text)` and `formatCanonicalDocument(document, declaredKeys)`
are synchronous codecs with no storage or editor lifecycle. A
`CanonicalDocument` contains every frontmatter field and the plain Markdown
body. Unknown fields and representable values that fail the table's schema
remain in the document. Schema validation belongs to `inspectRow`.

A form that owns a row's complete input uses `table.edit`, which applies these
codecs and the coordination below; see [Editing a row](#editing-a-row). Use
the codecs directly for a complete-row command outside an editor, such as a
script that rewrites a row canonically: read a snapshot, parse its exact
`text`, change a copy of `fields` or the `body`, format it, and replace the
file on the condition that it still holds the bytes read:

```ts
import {
  formatCanonicalDocument,
  parseCanonicalDocument,
} from '@epicenter/folder';

// Reuse this order for every draft and disk observation of this table.
const declaredKeys = Object.keys(definition.tables.todos.fields);
const { data: document, error: refusal } = parseCanonicalDocument(snapshot.text);
if (refusal !== null) return showRawText(snapshot.text, refusal.reason);

const next = {
  ...document,
  fields: { ...document.fields, done: true },
};
const { data: text, error: formatError } = formatCanonicalDocument(next, declaredKeys);
if (formatError !== null) return show(formatError.reason);

const { error: saveError } = await folder.tables.todos.replace(snapshot.stem, text, {
  expectedSha256: snapshot.sha256,
});
if (saveError !== null) show(saveError.message); // Conflict: the row changed since the read
```

Canonical formatting quotes keys, fixes field order and normalizes YAML
presentation, including removing frontmatter comments and the byte-order mark,
and using LF in the header. The codec preserves the supplied body exactly.
The first canonical save can therefore reformat a file created with `create`.
A successful format does not mean the fields conform: for example, a string
in a boolean field still formats and saves through `replace`.
To remove a field, omit its key from the copied object; `undefined` has no
canonical form. To compare two documents, format both with the same key
order. Comparing canonical text with original text would mistake
presentation differences for edits.

Malformed YAML and values without an exact supported representation return a
`CanonicalRefusal` (`reason`, `path`). A file may pass `inspectRow` and still
have no canonical form. Keep its original text accessible and repair it with
raw `replace`; never rebuild it from the partial fields inspection returned.

`{ expectedSha256: snapshot.sha256 }` refuses external edits made since the
snapshot as `Conflict`; `{}` replaces whatever row is there. A caller that
keeps its input across saves chooses the guard by the bytes that input was
reconciled with: the snapshot's hash, a later read's, or the last successful
receipt's. After `Unconfirmed` there is no receipt to advance to; reread
before choosing the next guarded save. `replace` requires an existing row and
never creates one; [Files](#files) gives each platform's guarantee and its
open defect. Missing files remain a visible outcome. To restore text on
purpose, use `files.create(rowPath('todos', snapshot.stem), text)`.

```text
file --get--> exact text --parse--> complete fields + Markdown body --> UI
                                      ^                            |
                                      +---------- input -----------+
                                      |
                                    format --> text --replace--> file
file-change hint --> reread --> app decides whether to adopt
```

An application that keeps complete input outside `table.edit` owns the
coordination the editor otherwise provides; the codecs and file methods
enforce no UI lifecycle. Change notifications are hints to reread,
not new content. Subscribe before the initial read and prevent an older read
from replacing newer input or observations. Drop or rerun a read that began
before the latest local save settled.
The folder does not order independent saves, so for eager autosave the
application serializes its own writes: one in flight and at most one pending
latest document, started when the running one settles. Rereading never
triggers a save by itself. Adopting disk content discards pending drafts from
before adoption; let already started writes settle, then reread before
adopting. An `Unconfirmed` write remains uncertain: a read does not cancel it
or prove it failed. The application chooses when its local saves yield to
disk.
See [Hints](#hints) for each adapter's observation coverage.

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
path separator, a backslash, or a control character is `InvalidPath`, so no
stem can address a nested path such as `todos/a/b.md`. Whether a name can be
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

Every mutation addresses its row by stem and takes required options. `{}`
acts on whatever the row holds now. `{ expectedSha256 }` is the SHA-256 of
bytes the caller reviewed, such as a snapshot's `sha256`: a condition on the
current bytes, checked where the change is published, and refused as
`Conflict` when they differ. It is not an identity, a revision, or an
acknowledgment: two files with the same text have the same hash. Options are
read and validated when the method is called, before anything is awaited.
Absent or non-object options, an object with any enumerable own string key
besides `expectedSha256` (a misspelled guard, or a snapshot passed where
options go), and a guard that is not a lowercase SHA-256 are `InvalidPath`.
Symbol, inherited, and non-enumerable keys other than the guard are not
inspected. Nothing retries.

Only an absent `expectedSha256` means the current row. One that is present
but `undefined`, as `{ expectedSha256: snapshot?.sha256 }` makes when there is
no snapshot, is `InvalidPath` before anything is read, so a guard that went
missing on its way to the call never becomes an unguarded write. Presence
counts an inherited or non-enumerable property too, and a getter is read
once. The type cannot refuse it, since the property is optional and the
compiler does not use `exactOptionalPropertyTypes`; the runtime refuses it,
as it refuses uppercase hex. A caller with an optional baseline chooses
explicitly: `snapshot ? { expectedSha256: snapshot.sha256 } : {}`.

Requiring the argument makes each call site say which it means, and makes a
wrapper that drops it fail to compile where it calls the table. It does not
make a wrapper forward what it was given: one that passes `{}` of its own
drops its caller's guard, and neither the type nor the runtime can tell. A
wrapper passes the options it receives.

```ts
const guard = { expectedSha256: todo.sha256 };
await folder.tables.todos.update(todo.stem, { fields: { done: true } }, guard);
await folder.tables.todos.replace(todo.stem, repairedText, guard);
await folder.tables.todos.rename(todo.stem, 'groceries', guard);
await folder.tables.todos.delete('groceries', guard);
```

`update(stem, change, options)` checks the supplied values, reads the current
text once, checks the caller's baseline against that read, and patches it:
it replaces only the touched frontmatter value spans or appends new keys.
Comments, quoting, key order, unknown keys, a byte-order mark, and CRLF line
endings survive. Fields the update does not assign may have issues; that does
not block it. The current text must parse, even to change only the body.
The save is always conditional on the bytes this call read, so a writer that
lands between the read and the publication is a `Conflict`. That internal
condition is separate from the caller's guard: it covers only this call's own
read, never what the caller reviewed earlier. A missing row is `Conflict`
with a guard and `NotFound` without one. Nothing is rewritten on a refusal.

`replace(stem, text, options)` encodes the complete text of the file as UTF-8,
so text that does not parse can be saved and later repaired. It reads nothing
before or after. The row must exist: a missing row is `NotFound` unguarded and
`Conflict` guarded, and a replacement never creates a file.

`create`, `update`, and `replace` return a write receipt,
`{ stem, path, text, sha256 }`, for the bytes they submitted. It carries no
`fields`, `body`, `issues`, or `parseError`;
`inspectRow(definition.tables.<name>, receipt.text)` interprets it. Nothing is
read back. The receipt's `text` is the whole file those bytes decode to: it is not the string that was passed where encoding replaced
an unpaired surrogate. Storage still reports partial or uncertain outcomes
through its operation error. What the text reads as does not decide whether it
is saved: text that does not parse, and text with a field that does not
conform, are saved by `replace` all the same. A field whose validator or
refinement throws on a stored value is a field that does not conform: it is
left out with an issue, and the other fields and the body are still read.

`rename(stem, nextStem, options)` and `delete(stem, options)` return
`Ok(undefined)`. A rename reads only the table directory, for its destination
check; it reads and decodes no row for a reply, so a caller that needs the row
at its new path keeps the baseline it guarded the move with or reads it. A
move that landed its destination but kept its source is
`MoveError.SourceNotRemoved`; its `moved` capture is present only when the
rename was guarded, since an unguarded move never learned which bytes it
carried. Like any moved capture, it is the guard hash at the destination, not
a read of it. Renaming a row to its own stem is `InvalidPath` before anything is
read: such a move would check neither existence nor the baseline, so it is
refused rather than reported as done. A caller whose name did not change
skips the call. A delete of an absent row is `NotFound`, guarded or not; it
does not count as done.

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
an undeclared key it stays in the text unreported.

| Refusal | Error | Wrote anything |
| --- | --- | --- |
| A supplied value is undeclared, does not conform, is missing from a new row, or cannot be copied or written as YAML | `InvalidValues`, with `issues` | No |
| The stem does not address a row in this folder, options are absent or hold an enumerable own string key besides `expectedSha256`, `expectedSha256` is present but not a lowercase SHA-256 (`undefined` included), or a `rename` names the stem the row already has | `InvalidPath` | No |
| `create` or `rename` found the destination taken | `Exists` | No |
| `update` found no row at its read, without a guard | `NotFound` | No |
| `update` read text that does not parse | `Unparsed`, with the parse `error` | No |
| `update` read text that parses but cannot be patched without changing text it was not asked to change: an anchor, alias, or tag on the value, or a flow mapping | `UnsupportedSource` | No |
| The file changed, or went away, before publication | `Conflict` | No |
| Storage failed | `Io` | No |
| A rename stopped between its two steps | `Partial` | Yes: the destination holds the bytes |
| The outcome is unknown: the desktop owner's reply was lost, or a browser file's stream failed to close | `Unconfirmed` | Unknown |

Each method's error type adds its own preparation failures to the shared storage family: `TableGetError`,
`TableEnumerationError`, `TableReadError` for one listed file,
`TableCreateError`, `TableUpdateError`, `TableReplaceError`,
`TableRenameError`, and `TableDeleteError`. `TableWriteError` is their union
for code that presents any save failure alike.

`patchRowText(text, { fields?, body? })` and `frameRowText(text)` are
exported for editors that keep their own buffer. Both take the whole file's
text; `body` is only what follows the closing fence. `patchRowText` keeps every
byte it was not asked to change, unknown keys and comments included, and has
the same refusals as `update`, as `unparsed`, `value`, and `unsafe`; it checks
no table fields.

### Choosing a save

Each kind of caller combines the same primitives. The guard is the hash of
the bytes a decision was made from; whether to pass one depends on whether
the change was derived from those bytes.

```ts
const todos = folder.tables.todos;

// A checkbox assigns a value that does not depend on the rest of the row.
await todos.update(stem, { fields: { done: true } }, {});

// A title derived from the body the person reviewed. With `{}`, the update's
// own read would be a newer body, and the title would land over it.
await todos.update(
	snapshot.stem,
	{ fields: { title: firstLine(snapshot.body) } },
	{ expectedSha256: snapshot.sha256 },
);

// Raw repair of text that does not parse, against the text the person saw.
// An `InvalidUtf8` read has no snapshot; its `sha256` guards the same way.
await todos.replace(snapshot.stem, repairedText, { expectedSha256: snapshot.sha256 });

// Rename or delete the row the person selected, as they saw it.
await todos.rename(snapshot.stem, 'groceries', { expectedSha256: snapshot.sha256 });
await todos.delete(snapshot.stem, { expectedSha256: snapshot.sha256 });

// A new row: preview the draft's text and its issues, then create it.
const { data: preview } = serializeRow(definition.tables.todos, { fields: draft, body });
const issues = inspectRow(definition.tables.todos, preview).issues;
await todos.create({ fields: values, body });

// An existing row's text: patch it, so what was not touched survives.
const { data: patched } = patchRowText(snapshot.text, { fields: { title } });
await todos.replace(snapshot.stem, patched, { expectedSha256: snapshot.sha256 });
```

| Operation | What the table reads while preparing | Missing row, `{}` | Missing row, guarded | Returns |
| --- | --- | --- | --- | --- |
| `create` | the table directory, for the destination | not applicable | not applicable | receipt |
| `update` | the row, once | `NotFound` | `Conflict` | receipt |
| `replace` | no row | `NotFound` | `Conflict` | receipt |
| `rename` | the table directory, for the destination | `NotFound` | `NotFound` | `undefined` |
| `delete` | no row | `NotFound` | `NotFound` | `undefined` |

The column is the table's own preparation. Publication is separate: where a
change carries a condition, the storage publisher reads and hashes the
current bytes to check it, in the desktop owner process for a desktop folder.
`update` reads because a patch needs the current text, and it publishes
against that read whether or not the caller guarded it. `replace` already
holds the complete text. `rename` and `delete` are prepared without the row,
and publication finds whether it is there.

A receipt names the bytes a save submitted; it is not an observation of the
file. After `Unconfirmed`, a read that finds the same bytes does not confirm
that save: another writer can produce the same text, so nothing infers an
acknowledgment from matching bytes. A hint asks for a reread; it is not a
snapshot, a receipt, or an acknowledgment. On a desktop folder, the guard is
checked before publication by the owner process; another program writing at
the same moment can still race it.

### Editing a row

`tables.<name>.edit(stem, { signal })` acquires an editor fixed to one row.
The table supplies the row's path, schema, and declared field order. The
editor holds the row's latest complete input and saves it with one running
write and at most one waiting text, for structured and raw input alike. [Complete-row editing](../../docs/adr/0504-row-editors-own-complete-input-and-one-publication-queue.md)
records the decision. Applications move to this editor in a coordinated
caller cutover; [the execution evidence](evidence/complete-row-editing.md)
tracks it.

```ts
const { data: editor, error } = await folder.tables.todos.edit(stem, { signal });
if (error !== null) return showOpenError(error);   // Aborted, NotFound, InvalidUtf8, Io, ...
const { get, subscribe, set, setText, retry, waitForSaves, reload } = editor;

const stop = subscribe(() => render(get()));          // no initial call: subscribe, then read
render(get());

const { row } = get();
if (row.status === 'valid') {
  const { error: setError } = set({ fields: { ...row.fields, title: 'Plan B' }, body: row.body });
  if (setError !== null) show(setError.message);     // Unrepresentable: nothing changed
}
setText(repairedText);                                // raw input saves the same way
retry();                                              // after a failure: save the current text again
const { error: saveError } = await waitForSaves();    // wait until no write runs; never retries
const { error: reloadError } = await reload();        // adopt the file's text, discarding input
```

```text
get(): { row, save }        one frozen snapshot, the same object until a part changes
row                         the latest input, always shown
|-- valid       { text, fields, body }   the complete parse of text, unknown metadata included
`-- invalid     { text, error }          Unencodable | NoCanonicalForm | Nonconforming
save
|-- idle
|-- saving      { error? }               while a write runs; prior failure stays visible
`-- failed      { error }                the latest attempt's FileError (Unconfirmed may have landed) | Unencodable
```

- Acquisition. `edit` reads the row once. Readable text opens whether or not
  it conforms, so malformed or schema-invalid text is repaired through the
  same owner. A missing row is `NotFound`; an unreadable or non-UTF-8 file,
  an address the folder does not admit, and an aborted `signal` open
  nothing. `signal` governs acquisition only. There is no disposal.
- Input. `set` takes a complete row: every field to keep and the body. It
  reads only `fields` and `body`, so a valid row can be spread back with
  changes. Omitted keys are deleted; nothing is merged from disk or earlier
  input. It formats before returning, so later changes to the caller's
  objects change nothing held or waiting. Schema-invalid values are kept
  and saved; a value with no canonical form, such as `NaN`, is
  `Unrepresentable` and changes nothing. `setText` takes raw text exactly,
  malformed frontmatter included. Either way the text is the row snapshot
  before the setter returns.
- Canonical form. Declared keys come first in declared order, other keys in
  code unit order, every key quoted and every value in JSON flow style.
  Unknown keys and nested values are kept; comments, quoting, and header line
  endings are not. The body is kept exactly. Acquisition and reload never
  write.
- Writes. One write runs at a time. Only the latest text set while it runs
  waits, and it is written when the running write completes, whether that
  saved or failed; text a newer setter replaced first is never written. A
  running write is never
  cancelled, and its receipt never replaces newer input. Each write is an
  unguarded `replace` of the existing row. Nothing orders it against other
  editors, handles, or pages: the last save to land stays, and a write that
  hashed or travelled longer can land after a save asked for later. A
  deletion before the write yields `NotFound` without recreating the row,
  where storage holds `replace` to that: [Files](#files) names each
  platform's guarantee and native replacement being unavailable on Windows.
- Failure. `save` reports the latest attempt. A failure with input waiting
  stays visible as `saving.error` while that input writes; a failure with nothing
  waiting is `failed` until the next input, which saves at once and retains the error. A successful save clears the error. Nothing
  retries on its own. `retry()` saves the current text again, even when it
  is the text that failed, and does nothing unless `save` is `failed`.
  `Unconfirmed` may have landed: present it as uncertainty; no later read
  confirms it. Raw text with a lone surrogate is held as invalid and fails
  its turn with `Unencodable` rather than writing lossy bytes.
- `waitForSaves()` waits until no write runs or waits, through every write
  of input set meanwhile, a subscriber's included. It returns `Ok` when the
  last attempt saved and its error when it failed, at once when nothing is
  writing. It never starts a write.
- `reload()` is the only read after acquisition. It waits as `waitForSaves`
  does, then reads the row. On success the file's text becomes the row and `save`
  becomes `idle`: retained input and its failure are discarded on purpose.
  A failed read is its `TableReadError` and changes nothing: the row stays
  visible and editable. A setter after the call, the same text included, or
  a `retry`, makes it `InputChanged`, and the newer input stands. When
  reloads overlap, the latest call decides and the earlier ones resolve with
  its result. Discarding a held `Unconfirmed` failure does
  not confirm or cancel that earlier write; `idle` describes later writes
  only.
- Subscription. `subscribe(invalidate)` makes no initial call. It hears
  changes to the snapshot in memory only: subscribing reads nothing and
  watches no change hints, and the editor never follows the file by itself.
  Delivery is never reentrant, and what a listener throws is logged and
  reaches no operation or other listener.
- Retention. Methods close over the editor and never read `this`, so they
  can be destructured or passed as handlers. The application keeps the owner
  through pending or failed writes. Before closing the folder or moving the
  row, it stops input and awaits `waitForSaves()`; on failure it retries, reloads,
  or releases the owner.

`table.update` and `table.replace` keep their own conditional,
text-preserving contracts; the editor is the save shape for forms that own
complete input. `TableEditError` is the acquisition error union; `RowError`,
`RowSetError`, `RowSaveError`, and `RowReloadError` are the editor's.

`evidence/edit-handle/canonical-web` shows this contract from vanilla DOM,
Solid, and Svelte views of one editor, with an owner that leaves a row only
after its saves settle; `evidence/edit-handle/canonical-callers.md` describes
it. The rest of `evidence/edit-handle/` is an earlier, historical editor.

### Editing a row in Svelte

`@epicenter/folder/svelte` exports `fromRowEditor` and `ReactiveRowEditor`
over the row editor's `get`, `subscribe`, `set`, `setText`, `retry`,
`waitForSaves`, and `reload`.
Svelte 5.9 or later is an optional peer; no other entry loads it.

```svelte
<script lang="ts">
  import { withFileNewlines } from '@epicenter/folder/file-browser';
  import { fromRowEditor } from '@epicenter/folder/svelte';
  import { Input } from '@epicenter/ui/input';
  import { Textarea } from '@epicenter/ui/textarea';

  let { rowEditor } = $props(); // retained above this view
  const editor = $derived(fromRowEditor(rowEditor));
  const lf = (text: string) => text.replace(/\r\n?/g, '\n');
</script>

{#if editor.save.status === 'failed'}
  <SaveFailure error={editor.save.error} />
  <button onclick={editor.retry}>Save this text again</button>
{/if}
{#if editor.row.status === 'valid'}
  {@const row = editor.row}
  <Input aria-label="Title" bind:value={
    () => row.fields.title,
    (title) => {
      if (editor.row.status !== 'valid') return;
      const { error } = editor.set({
        ...editor.row,
        fields: { ...editor.row.fields, title },
      });
      if (error !== null) showRefusal(error);
    }
  } />
  <Textarea aria-label="Body" bind:value={
    () => lf(row.body),
    (body) => {
      if (editor.row.status !== 'valid') return;
      const { error } = editor.set({
        ...editor.row,
        body: withFileNewlines(body, editor.row.body),
      });
      if (error !== null) showRefusal(error);
    }
  } />
{:else}
  <RowProblem error={editor.row.error} />
  <Textarea aria-label="Markdown source" bind:value={
    () => lf(editor.row.text),
    (text) => editor.setText(withFileNewlines(text, editor.row.text))
  } />
{/if}
```

The reactive render-time `row` makes the structured getters total. Writes use the
current `editor.row`, so another field's edit is preserved. The application supplies
`showRefusal` and retains any input the editor refuses.

The shared view doctrine is [ADR-0507](../../docs/adr/0507-editor-views-compose-current-input-and-own-only-interaction-state.md).
Source, field forms, and body codecs share this owner. The default renders
structured controls for valid rows and source for invalid rows, with no selection
state. Repair that validates returns to structured rendering. Add Tabs only for
a real choice among views of valid input; that choice has one selection owner.
Derive validity and save presentation from the editor. Shared `Tabs.Content`
unmounts inactive children and shared `Input`/`Textarea` retire destroyed value
bindings. Keep refused input and unfinished sessions above those views, and check
current-row eligibility in structured setters. A view component earns its place
through substantial UI, transformation, or lifetime ownership; forwarding one
binding does not require a component.

- Reads. `row` and `save` return the owner's current `get()` parts every
  time; the wrapper copies nothing. A read inside an effect, or inside a
  derived an effect reads, also subscribes through one `createSubscriber` to
  the owner's in-memory snapshot; the subscription ends a microtask after
  the last reading effect is destroyed. Subscribing reads no file and
  watches nothing. Reads outside any effect or derived subscribe to nothing.
  Read the native `rowEditor.get()` imperatively for nonreactive work. A
  destructured `row` is a snapshot, not a tracked read.

- Commands. `set`, `setText`, `retry`, `waitForSaves`, and `reload` are the owner's
  own functions, safe to pass as handlers. Adapting the same owner again
  returns the same wrapper. Switching a view to another owner ends the
  subscription to the first; its admitted writes finish.
- Binding eligibility is caller code. Structured controls render under a valid
  row, and setters check the current row and application eligibility at the event. A leaving view keeps its input listener:
  Svelte pauses an outroing view's effects rather than destroying them and
  marks it `inert`. Ordinary typing stops in a browser, but a committing IME
  composition, assistive technology, script, or a form reset can still
  deliver input, and an unguarded setter then replaces the whole row. A
  destroyed view keeps them too: Svelte never removes the listeners its
  bindings add to an element, so a control something still holds can call a
  setter after the view unmounts, with or without an outro. The shared UI
  `Input` and `Textarea` guard destroyed value bindings. Native controls,
  other handlers, and leaving views still need their own lifetime rules. The adapter and
  the native setters guard nothing.
- Forms. Live-bound fields do not belong in a resettable form: a reset submits
  each field's `defaultValue` through its setter. An application draft can
  own reset instead.
- Newlines. Textareas report LF. Getters normalize CRLF to LF, so Svelte never
  sees a mismatch and rewrites the field; setters restore the file's
  convention with `withFileNewlines`, for raw text and for body text,
  trailing newlines included. A structured `set` writes the header in LF and
  keeps the body's line endings. A raw setter whose reference text has any
  CRLF writes CRLF on every line, header included, so a header a structured
  save wrote in LF turns CRLF after a raw edit and LF again after the next
  structured save. Text with mixed line endings comes back uniform from any
  textarea edit; the textarea cannot report which line had which.
- Refusal. A refused `set` changes nothing. Where a control can hold input
  the codec refuses, retain that field locally for correction. Ordinary row
  bindings submit immediately to the owner and need no second whole-row draft.
- Lifetime. Unmounting ends the subscription only. Admitted writes, a failed
  save, and retained input belong to the owner, so keep it above conditional
  views.

`src/svelte/row-editor.svelte.test.ts` mounts compiled fixtures in jsdom over
a real `table.edit` owner. It covers tracking, bindings, conditional views,
and subscription lifetimes, not layout, focus, selection, IME, or storage
latency. It dispatches input on leaving views directly, which jsdom permits
because it implements no `inert`: that shows what a delivered event does, not
that a person can type there.

### Reading and saving kv.json

`kv` is one fixed root file holding a sparse map of declared values. It uses
the same two diagnostics as a row (ADR-0487).

```ts
const { data: snapshot, error: readError } = await folder.kv.get();
if (readError !== null) return showReadFailure(readError); // handle this before any default
const kv = { ...KV_DEFAULTS, ...(snapshot?.values ?? {}) };
showDiagnostics(snapshot?.parseError, snapshot?.issues ?? []);
```

| Outcome | Where it is | What it carries |
| --- | --- | --- |
| The file is absent | `get`: `Ok(undefined)`. | Nothing. No capture is invented. |
| The file could not be read as text | The `Err` of `get`: I/O, a directory at the path, a closed folder, or `InvalidUtf8`. | No text. |
| The text is not one JSON object | `snapshot.parseError`. | `values` is empty and `issues` is empty. `text` is the whole file. |
| The text is a JSON object | `snapshot.parseError` is `undefined`. | `values` holds every stored declared value that validated by itself. `issues` has an entry for each stored value that does not conform. |

The format is one strict JSON object, after an optional byte-order mark.
Comments and trailing commas fail parsing. A root key that appears twice
reads as its last value, as `JSON.parse` reads it.

A declared key the file does not have is left out of `values` and is not an
issue. An undeclared key stays in the text and is not reported. Values live
under `values` so a declared key named `text` or `issues` cannot collide
with the capture. Values and diagnostics are frozen at every depth.

The folder has no defaults. `get`, `inspect`, preparing the definition, and
opening the folder insert nothing and save nothing. An application applies
its own defaults where it derives its state, as above: a missing file, a
missing key, and a stored value that was left out all fall back, and a stored
`null` does not. The merge is one level deep.

`inspect(text)` is the same reading of text that was not saved:
`{ values, parseError, issues }`, with no path, hash, or Result.

`create(values)` checks the supplied values and saves a new file without
reading; an existing file is `Exists`. `update(values)` reads the current
text once, assigns the supplied root keys, and replaces what it read. Both copy
the supplied values when they are called, accept readonly values such as a
snapshot's, and leave the caller's objects as they were. A receipt is the
snapshot of the submitted text and its hash, with nothing read back. An
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
Repair the complete text with `files.replace(snapshot, text)`. That returns
a raw capture; call `kv.inspect` on the text that was submitted to see how it
reads. `KvReadError` and `KvWriteError` are the two error unions.

### Merging kv.json

`mergeKv({ base, ours, theirs })` reconciles three captured `kv.json` texts
without opening a folder. Each input is a JSON object string or `null` for a missing
file. Rust exposes the equivalent `kv_merge::merge_kv(base, ours, theirs)` in
`epicenter-folder-core`. Both implementations run the same fixtures.

For each root key, equal choices agree; a side unchanged from the base yields
to the other side. Competing changes return `kind: 'conflict'` with each key's
raw base, ours, and theirs values. Nested objects and arrays stay together as
one value. A missing key differs from a stored JSON `null`. Deleting the file
conflicts with a change to its values and returns `kind: 'file-conflict'`.

A successful result has `kind: 'merged'` and `text`, the complete merged file
text, which is `null` for a deleted file. It preserves selected value text and
regenerates root formatting with sorted keys. Object key order and string escape spelling do not affect
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

### One file per save

Every save changes one file, or for a move one source and one destination.
There is no multi-file transaction: an application that keeps a row beside a
media file saves the media first and the row after, and on a failure between
them reads what landed before deciding what to save next.

### Editor policy

The application chooses its local buffer, save trigger, and response to incoming
content independently. A checkbox can submit immediately and display confirmed
data until success. A title input can bind to local state and save on blur,
debounce, or an explicit action. A document can keep a complete-source buffer.
The folder requires no timer, UI binding, or shared editor controller. A form
that owns one row's complete input can use `table.edit`, which takes each
input at once and writes the latest over the existing row; see
[Editing a row](#editing-a-row).

An application may replace local input whenever it reads external content,
refresh only while clean, or keep its local draft. Following external content
while typing can discard unsaved input. Keeping a draft does not choose its
save condition: `files.replace(capture, text)` refuses changed content, while
`files.overwrite(path, text)` deliberately replaces whatever is there.
An application offering review can compare its baseline, latest observation,
and draft before conditionally saving against the reviewed capture.

`tables.<name>.update(stem, { fields?, body? }, options)` reads the current
row and patches only the requested fields/body. With `{}`,
changes saved before that read survive when they concern other parts; with one, any change since the caller's observation is a `Conflict`. A
race after the read returns `Conflict`; there is no automatic retry. A missing
row returns `NotFound`, or `Conflict` under a baseline, and is never created
by an update. The caller may inspect `error.name` and decide what to do.

For `update`, `NotFound` means the row was absent at its initial read;
`Conflict` means the caller's baseline or the publication condition failed,
including removal between read and save (`actualSha256 === undefined`).
`Unconfirmed` means the outcome is unknown. These are common outcomes, not the
entire error union: see [Saving a row](#saving-a-row). No outcome triggers
automatic replay.

`replace(stem, text, { expectedSha256: snapshot.sha256 })` saves the complete
text of the file against the snapshot's captured bytes. It accepts text that
does not parse and returns the receipt of the submitted bytes. It does not
merge fields, normalize text, or read before or afterward. With `{}` it
replaces whatever row is there, and still never creates one.

A snapshot is already a file capture, so `files.replace(snapshot, text)`
also works and returns only the new capture. The table method addresses the
row by stem, so it cannot be pointed at a file outside the table.

An editor checks its unsaved buffer with
`inspectRow(definition.tables.<name>, buffer)`. It should not mix
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
`log`, `add`, `commit -m`, `push`, `fetch`, `pull --ff-only`, and `merge`. A
redirection is a deliberate overwrite; a rewrite of a file the same command
read is conditional on what it read. `add` and staged `commit -m` need
`commitOnEdit: false`. `git merge` merges the already fetched remote branch
(`pull --ff-only` fetches first). With `commitOnEdit: false` it leaves
conflicts in the files and exits 1, as Git does, and the shell's file list
includes what the merge wrote either way, so `git merge; cat notes/color.txt`
shows the markers. `git status` then reports `UU` and the other unmerged
codes, and `git commit -m` refuses while a path is unmerged, naming it,
until `git add` stages its resolution. A command holds nothing between its steps, in the
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

With `commitOnEdit` (default `true`), each complete table, KV, or file save
this handle published asks for a commit in the background. If another tab, a
pull, a staged command, or an earlier commit holds the folder's Git work, the
request waits for it, together with every later request: when that work ends,
one commit captures the latest files without another save. Each handle keeps
at most one such waiting request, and no copy of the saved bytes. Any
whole-folder commit, including an explicit `commit()`, answers the requests
made before it started. An automatic waiter whose requests were already
answered skips capture and records nothing. A browser or Bun save racing an
admitted capture can authorize one later `unchanged` pass, which creates no
empty commit. A commit that fails is reported in
`git.snapshot.lastCommit` and is not retried; the next save asks again.
There is no timer and no commit when the folder closes: a request still
waiting then is dropped, so the last save can stay uncommitted indefinitely.
Edits made by another program or tab, and saves that stopped partway or whose
outcome is unknown, ask for nothing. `git.snapshot.files` turns `stale` when
a save lands after the last capture, and `git.status()` lists what is
uncommitted.

The browser and Bun openers use local `main`. A remote branch selects the
transfer destination; it never selects another local history. An existing
repository with `HEAD` on another branch refuses commits and incoming
adoption until its branch is deliberately reconciled.

Automatic commits and `commit()` stay local, even with a configured remote.
Only explicit `push()` or `commitAndPush()` requests upload history.
`commitAndPush()` commits and then pushes;
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
const { error: saveError } = await folder.files.create('note.md', 'Saved before leaving');
if (saveError !== null) return show(saveError.message);
await folder.close();
```

A helper still reading or hashing can be refused at its next storage call. An
already-started application returns its actual Result, including `Partial` or
`Unconfirmed`. Closing never relabels that outcome. A browser write that
already holds the files lock can finish after close returns, although its
cross-tab hint can be lost once the notification channel closes.

A Git request still waiting for admission is refused; work that already
entered its protection
settles before storage is released. No final commit is required, and saved
files can remain uncommitted after close.

In the desktop app, closing detaches this page. The owner keeps the folder,
finishes operations it already accepted, the commit, and any push or fetch it
had already started for the page, and serves every other window. A push or fetch of the page that
the owner had not started is withdrawn and never starts. The owner makes no
commit because a page closed or the app quit: a save whose request was still
waiting when the app quit stays uncommitted there too.

### Incoming changes

Browser fetch uses isomorphic-git 1.38.5, which fails when a non-default
remote branch exists but the server advertises no resolvable `HEAD`. This
failure leaves local files and history intact.

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

A browser folder publishes an incoming update in steps, under its Git Web Lock
and then its files lock. Ordinary saves take only the files lock. They wait
while an incoming update publishes or recovers its working tree, index, and
branch, but not for fetching or preparing the incoming Git objects.

1. Admission. Every portable file must still have the hash the update
   captured, no new file may have appeared, and the index must be the bytes
   its clean check left; otherwise nothing is written and the update is
   `Refused` or `StagedChanges`. A path the update writes a file at that holds
   a directory the update does not empty is refused here as `NotAFile`, as is
   one holding a file no portable path names, such as `.DS_Store`. A folder
   with no index first gets a valid empty one. Both commits are pinned under `refs/epicenter/incoming/`, and
   the record `.git/epicenter-incoming.json` is written: an operation ID, the
   branch, the head it was admitted over, and the commit it publishes.
2. Only after the record's stream closed: removals (pruning only the
   directories they emptied; empty directories a person made stay), then the
   directories the update emptied where it writes files, then writes, then
   the index, then the branch, compared with the pinned head.
   So `a/b` can become a file `a`, and a file `a` a directory `a/b`.
3. Once everything reads back as the published commit, the record and pins
   are removed.

A step that fails reports the steps that landed (`Partial`), or `Unconfirmed`
when its outcome is unknown; either way the record stays. The desktop Rust
owner retains its equivalent record at `.git/epicenter/incoming.json` and
recovers explicitly from pinned commits under the same rules.

The Bun directory opener applies ordered file steps, updates the index, and
moves the branch last. An unfinished merge instead writes its merge state
first (see [Unfinished merges](#unfinished-merges)). A failure reports the
steps that completed, marks the saved-files observation stale, and requests
no commit. It does not retain an incoming recovery
record: its `pendingIncoming` is absent and `recoverIncoming()` returns
`none`. Durable incoming recovery is implemented for the browser and desktop
Rust owner.

### Interrupted incoming updates

A browser record that remains, because a step failed or the tab closed, is
pending. `git.snapshot.pendingIncoming` shows it, and nothing resumes it on
its own. File saves continue; `stage()` is `IncomingPending`, a commit is
`blocked`, and pulls and merges are `IncomingPending` until it is resolved.

| `pendingIncoming.state` | Meaning |
| --- | --- |
| `recorded` | `{ operationId, branch, expectedHead, nextHead, merge? }`: the update was admitted and may have changed files. `merge` is present for a merge left unfinished; see [Unfinished merges](#unfinished-merges). |
| `unadmitted` | The record is empty: its admission never finished, so no authored file was changed by it. |
| `unreadable` | The record holds bytes that are not a record. It is never deleted automatically. |

`git.recoverIncoming()` resolves it explicitly:

| Result | When |
| --- | --- |
| `none` | Nothing was pending. |
| `admissionCleared` | The empty record was removed. Status is observed again. |
| `cleared` | The branch already names the published commit. The record is removed without writing files; status is observed again, not assumed clean. Never for an unfinished merge, whose branch does not move. |
| `completed`, with `changedPaths` | The branch is at the admitted head. Each changed path is at its before or after state; those at their before state are written, then the index and the branch, and the record is removed. For an unfinished merge, the index with its stages and the merge state take the branch's place. |
| `RecoveryRefused`, with `paths` | A path holds a third value (another file, an empty file where there was none, a file where a directory belongs, or a directory where the update writes a file that the update did not empty), or the index, the branch, or the record is not what the update left. A directory counts as emptied by the update only when it, and each directory in it, held a file the update removes. The paths are named, nothing is written, and the record stays. Restore them and recover again. |
| `Partial` or `Unconfirmed` | A recovery step failed or its outcome is unknown. The record stays. |

### Merging incoming changes

`mergeIncoming()` applies the already fetched remote head when histories
diverged. It pins the branch head and the fetched head, requires the same
clean folder as `pullFastForward()`, and refuses the same incoming commits. A
branch that is behind fast-forwards; a branch that is ahead or equal changes
nothing. It never fetches or pushes, and `pullFastForward()` still refuses
divergence.

Diverged histories normally need exactly one merge base; none or several is
`UnsupportedHistory`. `mergeIncoming({ allowUnrelatedHistories: true })`
explicitly combines histories with no common commit over an empty base. Both
heads remain parents of the merge commit. Several bases are refused either way. The merge writes one commit whose parents are the pinned
head and the pinned fetched commit, and publishes its files, a clean index,
and the branch the way a fast-forward does, with the same record.

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
`shape` for a file against a directory. By default a conflict or refusal
writes no file, index entry, or ref; unreachable objects may remain. With
`versions: true`, `Conflicted.versions` carries the exact committed bytes of
both sides at each conflicted file path, with `null` for an absent file. Shape
conflicts have no file versions. The native snapshot records conflict reasons
without broadcasting these bytes to other windows.

Browser folders, Bun directory folders, and the desktop app's Rust owner all
merge under these rules. The desktop owner merges a file both sides changed
with `git merge-file` and root `kv.json` with `kv_merge`, the Rust
counterpart of `mergeKv`; its conflict markers are Git's own, so its hunks
can differ from the browser's line merge.

### Unfinished merges

`mergeIncoming({ conflicts: 'leave' })` needs `commitOnEdit: false`; with
automatic history it is `AutomaticHistory` before anything is read or
written. It classifies conflicts the same way and, instead of refusing,
publishes the merge unfinished as Git leaves one, with the same admission
and record as any incoming update:

- Each conflicted path holds what a person resolves: ordinary markers
  (`<<<<<<< HEAD`, `=======`, `>>>>>>> origin/<branch>`) when every version
  is text the line merge keeps, the changed side's file against a deletion,
  and otherwise our bytes. A conflicted root `kv.json` gets ordinary markers
  too, which read as a parse error until it is resolved. Other paths are
  merged as in a clean merge.
- The index holds the merged files, and each conflicted path's stages in
  place of its entry: 1 for the base, 2 for ours, 3 for theirs.
- `ORIG_HEAD` names the local head, `MERGE_MSG` the merge message, and
  `MERGE_HEAD` the pinned fetched commit. The branch does not move.

The result is `conflicted`, with the conflicts and the changed paths. A
file against a directory, and a conflicted path that is a link, executable,
or submodule in one of its versions, are still refused and write nothing.

This state belongs to the repository and is read again, not remembered: it
survives closing and reopening, and `git.snapshot.merging` shows
`{ incoming, head, unresolved }` until the merge commit lands, including
after every path is staged. `paths()` reports `UU`, `AA`, `DU`, `UD`, `AU`,
`UA`, and `DD`. Reading status, diffs, or the snapshot never resolves a
path, and saving a resolution resolves nothing: `stage()` does, always
clearing that path's stages, whatever bytes it holds, including a deletion.

While the merge state exists, whole-folder commits, automatic commits,
pulls, and merges are blocked. Fetching still works and may move the tracking
ref; the merge's second parent stays `MERGE_HEAD`. `commitStaged()` while a
path is unmerged is `Unmerged`, names the paths, and writes nothing. Once
none is, it writes one commit whose parents are `ORIG_HEAD` and
`MERGE_HEAD`, even when the resolved tree equals the local tree, moves the
branch from `ORIG_HEAD` by compare-and-swap, and then removes `MERGE_HEAD`
and `MERGE_MSG`. Its result carries `incoming`. A branch that names any
other commit, before the commit or while it is written, is `BranchMoved`
with `expected` set to `ORIG_HEAD`: the files, the index, the branch, and
the merge state stay as they were. Moving the branch back to `ORIG_HEAD`
lets the merge finish. To abandon it, remove `MERGE_HEAD` and reset the index;
the working files remain available to repair. Without a readable
`ORIG_HEAD` the staged commit is refused, because the merge's first parent is
unknown.

Every built-in staged commit pins its parents, writes the staged tree and
commit as objects, and moves the branch only if it still names the pinned
first parent. A concurrent branch move is `BranchMoved` and leaves the index
unchanged. On disk, Git writes the tree from a private copy of the index:
intent-to-add placeholders stay out, while staged empty files, modes, and
deletions remain. Built-in commits run no commit hooks and are unsigned.

If that removal fails, the commit is still reported with `mergeStateWarning`.
While `MERGE_HEAD` remains, `snapshot.merging` stays visible. The next staged
commit removes that state when the branch names exactly the merge commit,
whose parents are `ORIG_HEAD` and `MERGE_HEAD`, so it never becomes the
second parent of another commit. A branch that only contains the incoming
commit is not taken for it; that state stays for a person to finish or
repair. A leftover `MERGE_MSG` alone does not keep a merge in progress.
There is no abort operation.

Unmerged index stages with no `MERGE_HEAD`, as when merge state was removed
by hand or damaged, also block whole-folder and automatic commits: a
checkpoint would reset the stages and record conflict markers as ordinary
content. The stages keep the base, ours, and theirs blobs. Restoring
`MERGE_HEAD` and `ORIG_HEAD` lets a staged commit finish the merge; staging
each resolution without them commits it outside the merge.

A browser or desktop publication that stops partway stays pending like any
incoming update. Recovery writes the remaining files, the index with its stages, and
the merge state, treating merge state it wrote itself as its own and any
other merge's as in the way. It never resolves a path, clears a stage, or
moves the branch, and a file edited since publication is a third state that
it names and refuses. Edits to paths the merge does not change survive.

A Bun directory keeps no record. Before any authored file it writes, in
order:

1. `ORIG_HEAD`, the local head.
2. `MERGE_MSG`, the merge message with a last line
   `# Incoming commit: <oid>` naming the fetched commit in full. Git strips
   `#` lines from a message it edits, as it does its own `# Conflicts:`
   list.
3. The whole index: the incoming entries and each conflicted path's
   stages, in one `git update-index`, so all or none.
4. `MERGE_HEAD`.

A staged commit with nothing staged is therefore `Unmerged` from the moment
a file can change, and never records the local tree as the merge. Nothing is
rolled back. Once the index holds the merge, another program may have staged
something in it too, and putting older index bytes back would erase that. A
failure is reported where it stopped instead. `Partial` then means the
merge's Git state was prepared and kept; its `applied` file steps may be
none.

- If `ORIG_HEAD`, `MERGE_MSG`, or the index cannot be written, the merge is
  `Refused` and no file or index entry changed. An `ORIG_HEAD` or
  `MERGE_MSG` left behind, with no `MERGE_HEAD`, is only a head and a
  message; no merge is in progress.
- If `MERGE_HEAD` cannot be written, the result is `Partial` with no file
  step, and its error names the incoming commit. The index keeps the
  stages and incoming entries with no `MERGE_HEAD`, and both commits refuse
  them: a whole-folder commit refuses orphan stages, and a staged commit is
  refused as unmerged. Before resolving, staging, or committing, use a system
  shell to write the commit on the `# Incoming commit:` line of `.git/MERGE_MSG` to
  `.git/MERGE_HEAD`. That line holds it even after a later fetch moves the
  tracking ref. The merge is then in progress as if it had been written,
  and a staged commit records `ORIG_HEAD` and that commit as parents.
- If a file step stops, `Partial` names the file steps that landed, possibly
  none. The merge stays in progress with its real unresolved paths and the
  incoming entries of files not yet written. Whole-folder commits stay
  blocked, and a staged commit records both parents only after each
  conflict is staged. Before staging everything, compare staged and unstaged
  differences (`git diff --cached`, `git diff`, `git status`): a file the
  merge did not get to write differs from its incoming entry, and staging it
  replaces that entry with what the folder holds, deletion included. Resolve,
  stage what each path should hold, and commit. To abandon the merge, remove
  `MERGE_HEAD` and reset the index; keep the working files for repair.

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

A definition is `{ title?, kv, tables }` and nothing else. `defineFolder`
throws on an `id`; an opener given an untyped definition with one returns
`InvalidDefinition`. Its type is `FolderDefinition`, the identity-free
`DataSchema` of `@epicenter/definition`, prepared with `prepareSchema`. A store
definition keeps its required `id` and its own `prepareData`.

`defineFolder` returns the prepared definition. It has the shape and type of
what was declared: `kv` and each table's `fields` are records of native
schemas, and a table's key is its name. Each table's type also carries the
`PreparedFolderTable` mark that `inspectRow` and `serializeRow` require; the
mark is a type, not a property. Each schema is an owned, frozen snapshot, so
editing a schema after `defineFolder` changes nothing an opened folder
accepts. An opener handed any other declaration prepares it first and reads
the snapshot.

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
| `src/browser-adapter.ts`, `tauri-adapter.ts` | The adapters the automatic entry loads lazily. The browser adapter also decides which OPFS directory is the folder. |
| `src/folder.ts`, `table.ts`, `kv.ts`, `markdown.ts` | The handle and its interpretation of files, shared by every adapter. |
| `src/editor.ts`, `canonical.ts` | The optional row editor `table.edit` opens, and the public complete-document codec usable independently of it. |
| `src/svelte/` | `@epicenter/folder/svelte`: tracked reads over a row editor, and its mounted jsdom tests and fixtures. The only code that loads Svelte. |
| `src/reading.ts` | The diagnostics a table and KV reading share: `ParseError`, `FieldIssue`, `DeepReadonly`, and the ownership every checked value has: parsed values frozen and supplied values copied before a field sees them. |
| `src/opfs-store.ts`, `git/opfs-git.ts`, `git/browser-backend.ts` | OPFS storage, private `.git`, and isomorphic-git. |
| `src/native-store.ts`, `git/native-*.ts` | The directory entry's files and `git` program. "Native" here means an ordinary directory in Bun, not the desktop shell. |
| `src/native-exchange.ts`, `addon/exchange.c`, `scripts/build-addon.ts` | The directory entry's atomic exchange for replacements: the Node-API addon, its loader and errno mapping, and the script that builds it. |
| `src/native/bindings.gen.ts` | Commands and events generated from the `tauri-plugin-epicenter-folder` crate. Internal. Do not edit. |
| `evidence/` | Tests that build real bundles and read real import closures; `evidence/opfs`, a page that runs the browser checks in a real browser; and `evidence/edit-handle/canonical-web`, vanilla, Solid, and Svelte callers of one row editor. The rest of `evidence/edit-handle` is historical. |

## Commands

```sh
bun run test              # build the addon, then native/core and mounted Svelte tests
bun run build:addon       # compile the Bun directory's exchange addon
bun run test:svelte       # only the mounted Svelte tests; they need --conditions=browser
bun run bench             # per-keystroke acceptance cost, natively and through Svelte bindings
bun run typecheck         # svelte-check: TypeScript and the .svelte test fixtures

EPICENTER_FOLDER_BRIDGE=1 bun test --isolate src/tauri-native.test.ts   # against the Rust owner
bun evidence/bundles/inspect.ts main tauri   # print the chunks a build emits
bun evidence/opfs/serve.ts   # the OPFS page on 127.0.0.1:5181; --build only compiles it
bun evidence/edit-handle/canonical-dev.ts   # the row editor callers page on localhost:5181
```

The browser suites run on an in-memory OPFS stand-in
(`src/opfs.test-support.ts`). They show the folder's protocol, not that a
browser's OPFS behaves like the stand-in; the evidence page checks that.
Application tests import `src/browser-storage.test-support.ts` by path:
`createTestStorage()` owns one fresh stand-in tree, `browserStorage(storage)`
opens it, and `testBrowserStorage()` does both in one call.

## Limits

A reference field has no integrity: nothing checks its target, and rename
repairs no references. `kv.update`
writes each value it assigns as compact JSON. Browser bytes are stored whole.
A whole-folder checkpoint or status scan reads and hashes the whole folder.
Version checks on disk are best effort
against other programs. File bytes cross the desktop bridge as JSON number
arrays, which is slow for large audio.

In a browser, OPFS quota exhaustion and eviction surface as the failing
step's `Io` or `Unconfirmed`; nothing reserves space. Nothing abandons a
pending incoming update: a record recovery refuses stays until the named
paths are restored. Pages of other origins or browser profiles are outside
what the Web Locks can see.


## Internal composition

Files, tables, KV, and the terminal use one storage API. Its `apply`
accounts for content changes, so a domain method cannot accidentally choose a
write that skips history or change hints.

```ts
createFiles({ storage })
createTable({ storage, onFilesChanged }, name, definition.tables[name].fields)
createKv({ storage }, definition.kv)
createTerminal({ storage, git }, options)
```

Browser and Bun openers wrap raw storage with publication accounting. The
Tauri owner already performs that accounting. Assembly fences the resulting
storage with the handle's close signal. These wrappers retain no file-operation
collection.

Git keeps raw storage because incoming fast-forwards update files and history
under their own policy. They must not trigger an automatic commit as a new
local save. Saves are not ordered by when their methods were called: the last
to land on a path wins. Terminal writes apply separately; a
recursive removal or directory move applies its captured file steps together.
