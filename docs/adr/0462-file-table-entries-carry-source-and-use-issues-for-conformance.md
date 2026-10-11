# 0462. Table snapshots expose usable fields and source diagnostics

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

Humans and agents edit the same Markdown files that applications read. A
readable file can have broken frontmatter or invalid fields. A repair editor
still needs its exact text and conditional-save baseline. A checkbox needs
only a valid `done` field, rather than proof that every field conforms.

Putting another Result inside each read makes both callers traverse an
interpretation wrapper before reaching their data. Promoting a complete field
map when an issue list is empty adds a second typing convention without helping
callers that already check the fields their action needs.

## Decision

A successful read returns an immutable snapshot with the file's exact `text`,
capture metadata, usable fields, and diagnostics directly. Acquisition uses one
outer Result. Absence is `Ok(undefined)`. Readable text that fails parsing is
still a snapshot.

```ts
import type { DeepReadonly } from '@epicenter/folder';

type ParseError = {
  readonly message: string;
  readonly diagnostics: readonly [{ readonly message: string },
    ...{ readonly message: string }[]];
};

type FieldIssue = {
  readonly field: string;
  readonly path?: string; // JSON pointer within the field, when available.
  readonly message: string;
};

type TableReading<TFields> = {
  readonly fields: DeepReadonly<Partial<TFields>>;
  readonly body: string | undefined;
  readonly parseError: ParseError | undefined;
  readonly issues: readonly FieldIssue[];
};

type TableSnapshot<TFields> = TableReading<TFields> & {
  readonly path: string;
  readonly stem: string;
  readonly text: string;
  readonly sha256: string;
};

// What a save submitted: the text its UTF-8 bytes decode to, and their hash.
type TableWriteReceipt = {
  readonly stem: string;
  readonly path: string;
  readonly text: string;
  readonly sha256: string;
};

type TableListing<TFields> = readonly {
  readonly path: string;
  readonly result: Result<TableSnapshot<TFields>, TableReadError>;
}[];

type FileTable<TFields> = {
  readonly name: string;
  get(stem: string): Promise<Result<TableSnapshot<TFields> | undefined, TableGetError>>;
  list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
  create(input: {
    readonly stem?: string;
    readonly fields: DeepReadonly<TFields>;
    readonly body?: string;
  }): Promise<Result<TableWriteReceipt, TableCreateError>>;
  update(stem: string, change: {
    readonly fields?: DeepReadonly<Partial<TFields>>;
    readonly body?: string;
  }, options: TableWriteOptions): Promise<Result<TableWriteReceipt, TableUpdateError>>;
  replace(stem: string, text: string, options: TableWriteOptions):
    Promise<Result<TableWriteReceipt, TableReplaceError>>;
  rename(stem: string, nextStem: string, options: TableWriteOptions):
    Promise<Result<undefined, TableRenameError>>;
  delete(stem: string, options: TableWriteOptions):
    Promise<Result<undefined, TableDeleteError>>;
  edit(stem: string, options?: { readonly signal?: AbortSignal }):
    Promise<Result<RowEditor<TFields>, TableEditError>>;
};

// Pure, from a table of the definition `defineFolder` returned; no folder.
function inspectRow<T extends PreparedFolderTable>(
  table: T, text: string): TableReading<CreateRowOf<T>>;
function serializeRow<T extends PreparedFolderTable>(
  table: T, draft: RowDraft<CreateRowOf<T>>,
): Result<string, InvalidValues>;
```

ADR-0464 defines `TableWriteOptions` and each mutation's publication
condition.

```ts
const { data: todo, error } = await folder.tables.todos.get(stem);
if (error) return showReadFailure(error);
if (todo === undefined) return showMissing();

showText(todo.text);
if (todo.parseError) return showParseFailure(todo.parseError);
showIssues(todo.issues);
if (typeof todo.fields.done === 'boolean') showCheckbox(todo.fields.done);

const draft = inspectRow(definition.tables.todos, buffer);
// Same diagnostics, without inventing a saved path, hash, or Result.
```

`inspectRow` is pure and synchronous. It parses once and checks each declared
field independently using the prepared definition. Reads, a caller
interpreting a write receipt's `text`, and unsaved drafts use this same
interpreter. It is a function of the definition, not a method of an open
table, so a draft is checked before any folder opens and a reading never
carries a path or hash it did not read.

`serializeRow` previews the text `create` would write for draft values,
through the formatter `create` uses: both fences, the declared keys present in
declared order, then the body, as the text its UTF-8 bytes decode to. It does
not check values against the schema, so a half-typed value previews and
`inspectRow` of the preview reports it. Values YAML cannot hold as supplied
and undeclared keys are `InvalidValues`. It is for new drafts only: a reading
omits unknown keys and fields that did not conform, so serializing the reading
of an existing row would lose them. An existing row's text changes through
`update`, `patchRowText`, or `replace` of edited text.

Both helpers take `PreparedFolderTable`, a phantom type that only
`defineFolder`'s return carries. A raw `defineTable` declaration does not
compile there. Before the mark, it compiled, read text whose declared fields
were all absent, and threw on the first declared value; `serializeRow` of it
succeeded while `inspectRow` of that preview threw. Definitions stay plain
runtime values: the mark adds no property, method, or symbol, and `openFolder`
still prepares a raw declaration. The mark is a type, not a proof of identity.
It survives a spread, so a table rebuilt with replaced or cloned fields
compiles, and reading a value through such a field throws as every read of an
unprepared schema does. Prepared schema objects must be retained; a changed
field or table needs `defineFolder` again.

The producer enforces these invariants:

| Interpretation | Fields | Body | Parse error | Field issues |
| --- | --- | --- | --- | --- |
| Parse failure | Empty | `undefined` | Present | Empty array |
| Parse success | Independently valid declared values | String, possibly empty | `undefined` | Zero or more |

Fields are always partial. Empty issues do not promote them to a complete row.
An invalid declared value is omitted. Every absent declared table field produces
an issue, including a nullable field: absence and a stored `null` are different.
Unknown keys stay in the text without issues merely for being undeclared.
Validation does not coerce, insert defaults, clean the text, or mutate it. A
valid field remains usable when another fails.

Row text requires opening and closing `---` lines around YAML, after an
optional initial BOM. LF and CRLF are supported. YAML must convert to a
string-keyed mapping; empty or comment-only frontmatter is an empty mapping. The
remaining text is the body. Missing fences, malformed YAML, duplicate keys,
non-mapping values, non-string keys, and failed alias conversion belong to one
parse-error family. Failed parsing exposes no partially recovered body or
fields.

TypeBox details remain inside the definition compiler. Public issues identify a
field, a message, and an optional pointer into that field's value. Messages and
issue counts are not machine contracts. Agents use field and pointer to locate a
repair, then inspect the edited text again. One field can have several issues.

Snapshot values and diagnostics are detached from mutable inputs and recursively
readonly and frozen. Freezing only the outer map would let nested edits make
`fields` disagree with `text` and `sha256`. Snapshots acquire no resources and
have no methods, signal, or close. They remain inspectable after folder close.
The exported `DeepReadonly` preserves branded primitives, unknown values,
fixed and variadic tuples, and recursive JSON types. Its tested implementation
lives in `reading.ts`; consumers do not duplicate the recursive type.

A field holds no callback (ADR-0525), so validation never writes to a value.
Typed commands copy supplied JSON values before validation, without freezing
caller-owned objects. Non-JSON values, including YAML binary, date, set, and
map tags, are rejected before validation. A declared non-JSON value produces a field issue while valid siblings and
the body remain usable. Undeclared tagged values stay in the text unreported.

Literal stems are addresses, not diagnostics. Append exactly `.md` to one
filename segment, without trimming, normalization, case folding, or an ID suffix
grammar. Empty stem addresses `.md`; `.MD` is an ordinary raw file. Scope
admission refuses escapes, private Git paths, and unsafe symlink traversal. The
actual filesystem determines representability. There are no filename issues.

`list` returns one item for every enumerated direct `.md` file. Malformed text
is an `Ok(snapshot)` with a parse diagnostic. Individual read or UTF-8 failures
are item errors. Disappearance after enumeration is individual `NotFound`.
Enumeration failure is the outer error, without a supposedly complete partial
inventory. Order is unspecified. This replaces `{ entries, unreadable }`.

Successful create, update, and replace return a compact write receipt,
`{ stem, path, text, sha256 }`: the text the submitted UTF-8 bytes decode to
and their hash, with no reread and no interpretation. Encoding can replace an
unpaired JavaScript surrogate; a receipt never assumes the original string
equals the encoded text. A caller that wants fields interprets the receipt:
`{ ...receipt, ...inspectRow(table, receipt.text) }` equals what a read of
those bytes returns. A receipt is a publication record, not a later
observation of the file. Editors acknowledge the decoded saved text without
replacing intervening input that encodes to different bytes.

Rename and delete return `undefined`. A rename reads only the table directory,
for its destination check, and decodes no row for a reply; a caller that needs
the row at its new address keeps the baseline it guarded the move with, or
reads it. A rename to the stem the row already has is `InvalidPath` before
anything is read: it would verify neither the row nor the guard, so it is
refused rather than reported as done.

Malformed complete-text replacement succeeds; `inspectRow` of the receipt
reports the parse error.

Structured create and update inputs accept recursively readonly field values, so
validated snapshot values can be passed back without casts. Methods copy inputs
without freezing caller-owned objects. Updates require parsing success, validate
only supplied values, and preserve unrelated text; ADR-0464 defines their
publication baseline.

Operation errors describe acquisition, preparation, or publication. Diagnostics
describe readable text. Forward storage failure families intact. Keep invalid
UTF-8 in acquisition, invalid supplied values in preparation, unparsed current
text distinct from unsafe patching, and occupied destinations in admission.
`Conflict`, `Io`, `Partial`, and `Unconfirmed` retain their effect contracts. No
diagnostic authorizes destructive action or promises a successful save.

## Consequences

One Result answers whether the operation succeeded. One flat reading answers
what the text contains and what needs repair. Applications check the usable
fields their action requires. A missing relation cannot prove no relation
exists; operations promising complete child discovery must refuse incomplete
evidence.

Saved diagnostics describe saved text. Draft diagnostics describe the buffer.
Neither interpretation success nor an empty issue list promises history,
synchronization, rich-editor compatibility, or absence of an external edit.

A caller that interprets a receipt writes one spread expression. A caller
that holds only a raw `defineTable` declaration prepares it with
`defineFolder` before previewing or inspecting text.

## Considered alternatives

A nested content Result repeats branching at ordinary typed callers. Treating
parse failure as a read error splits repair baselines across success and
failure. Returning only conforming rows hides files that most need repair.
Returning raw captures alone transfers schema interpretation into every
application. Whole-row validation loses independently usable fields. A
complete/partial type union adds proof that ordinary callers do not use.
Required schema defaults would make observed data describe values absent from
the file.

A parsed/unparsed union could narrow `body` after checking `parseError`. The
flat reading keeps this invariant at its producer; consumers needing a body
check its presence. Typed save helpers retain schema validation, row
addressing, and UTF-8 receipt fidelity that raw-only writes would transfer to
every application. Rename/delete wrappers also keep row-path admission in that
same boundary.

Receipts that carry a reading were the previous decision. A prototype over
the real table, since deleted with its regressions moved into
`table.test.ts`, measured the difference. Ten raw replaces of a row with one
refined field ran 0 refinements; interpreting each receipt ran 1 per replace.
Of the application call sites that received create or replace receipts, six
interpreted them, three used only the path, hash, or text, and three ignored
them. Medians on an in-memory storage stand-in (Bun 1.3.14, darwin/arm64):
replace alone took 0.032 ms and with interpretation 0.056 ms for a 67-byte
row, and 0.95 ms and 0.96 ms for a row with a 1 MiB body, because YAML parsing
stops at the closing fence. Nothing was measured on real origin-private
storage or through the desktop owner, and text whose frontmatter never closes
is scanned to its end. The case against a mandatory reading is semantic
rather than speed: it would run application refinements on every write for
callers that never read fields, and it would describe text the caller already
holds.

An interpreter on the open table (`table.inspect`) needed an open folder to
check a draft. Marking each field schema as prepared, in addition to the
table, was considered and rejected: a caller who clones a field object
reproduces the same identity gap one level down, so the extra mapped types buy
no stronger guarantee. A runtime preparation check, or a second lazy
preparation inside the helpers, would change the shared definition runtime for
a misuse the type already catches in its common form.

## Implementation

[Table commands](../../packages/folder/src/table.ts),
[pure interpretation and previews](../../packages/folder/src/row-text.ts),
[shared diagnostics and value ownership](../../packages/folder/src/reading.ts),
and [public regression coverage](../../packages/folder/src/table.test.ts)
implement this shape. Todos, Whispering, Honeycrisp, Capture, and Vocab
consume flat snapshots and inspect drafts and receipts with `inspectRow`.
