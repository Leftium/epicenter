# 0462. Table snapshots expose usable fields and source diagnostics

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

Humans and agents edit the same Markdown files that applications read. A
readable file can have broken frontmatter or invalid fields. A repair editor
still needs its exact source and conditional-save baseline. A checkbox needs
only a valid `done` field, rather than proof that every field conforms.

Putting another Result inside each read makes both callers traverse an
interpretation wrapper before reaching their data. Promoting a complete field
map when an issue list is empty adds a second typing convention without helping
callers that already check the fields their action needs.

## Decision

A successful read returns an immutable snapshot with source, capture metadata,
usable fields, and diagnostics directly. Acquisition uses one outer Result.
Absence is `Ok(undefined)`. Readable text that fails parsing is still a
snapshot.

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
  readonly source: string;
  readonly sha256: string;
};

type TableListing<TFields> = readonly {
  readonly path: string;
  readonly result: Result<TableSnapshot<TFields>, TableReadError>;
}[];

type FileTable<TFields> = {
  readonly name: string;
  inspect(source: string): TableReading<TFields>;
  get(stem: string): Promise<Result<TableSnapshot<TFields> | undefined, TableGetError>>;
  list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
  create(input: {
    readonly stem?: string;
    readonly fields: DeepReadonly<TFields>;
    readonly body?: string;
  }): Promise<Result<TableSnapshot<TFields>, TableCreateError>>;
  update(stem: string, change: {
    readonly fields?: DeepReadonly<Partial<TFields>>;
    readonly body?: string;
  }): Promise<Result<TableSnapshot<TFields>, TableUpdateError>>;
  replace(capture: FileCapture, source: string):
    Promise<Result<TableSnapshot<TFields>, TableReplaceError>>;
  rename(capture: TextCapture, nextStem: string):
    Promise<Result<TableSnapshot<TFields>, TableRenameError>>;
  delete(capture: FileCapture): Promise<Result<undefined, TableDeleteError>>;
};
```

```ts
const { data: todo, error } = await folder.tables.todos.get(stem);
if (error) return showReadFailure(error);
if (todo === undefined) return showMissing();

showSource(todo.source);
if (todo.parseError) return showParseFailure(todo.parseError);
showIssues(todo.issues);
if (typeof todo.fields.done === 'boolean') showCheckbox(todo.fields.done);

const draft = folder.tables.todos.inspect(buffer);
// Same diagnostics, without inventing a saved path, source hash, or Result.
```

`inspect` is pure and synchronous. It parses once and checks each declared field
independently using the compiled definition. Reads, submitted-source save
receipts, and unsaved drafts use this same interpreter.

The producer enforces these invariants:

| Interpretation | Fields | Body | Parse error | Field issues |
| --- | --- | --- | --- | --- |
| Parse failure | Empty | `undefined` | Present | Empty array |
| Parse success | Independently valid declared values | String, possibly empty | `undefined` | Zero or more |

Fields are always partial. Empty issues do not promote them to a complete row.
An invalid declared value is omitted. Every absent declared table field produces
an issue, including a nullable field: absence and a stored `null` are different.
Unknown keys stay in source without issues merely for being undeclared.
Validation does not coerce, insert defaults, clean source, or mutate it. A valid
field remains usable when another fails.

Row source requires opening and closing `---` lines around YAML, after an
optional initial BOM. LF and CRLF are supported. YAML must convert to a
string-keyed mapping; empty or comment-only frontmatter is an empty mapping. The
remaining text is the body. Missing fences, malformed YAML, duplicate keys,
non-mapping values, non-string keys, and failed alias conversion belong to one
parse-error family. Failed parsing exposes no partially recovered body or
fields.

TypeBox details remain inside the definition compiler. Public issues identify a
field, a message, and an optional pointer into that field's value. Messages and
issue counts are not machine contracts. Agents use field and pointer to locate a
repair, then inspect the edited source again. One field can have several issues.

Snapshot values and diagnostics are detached from mutable inputs and recursively
readonly and frozen. Freezing only the outer map would let nested edits make
`fields` disagree with `source` and `sha256`. Snapshots acquire no resources and
have no methods, signal, or close. They remain inspectable after folder close.
The exported `DeepReadonly` preserves branded primitives, unknown values,
fixed and variadic tuples, and recursive JSON types. Its tested implementation
lives in `reading.ts`; consumers do not duplicate the recursive type.

Folder freezes its own parsed JSON values before schema callbacks run. Typed
commands copy supplied JSON values and freeze the copies before validation,
without freezing caller-owned objects. A callback that attempts mutation yields
a field issue on read or `InvalidValues` on a typed command. Non-JSON values,
including YAML binary, date, set, and map tags, are rejected before callbacks
run. A declared non-JSON value produces a field issue while valid siblings and
the body remain usable. Undeclared tagged values stay in source unreported.

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

Successful create, update, replace, and rename return the same snapshot shape.
Receipts interpret the UTF-8-decoded submitted bytes and retain that text and
its hash, without a later reread. Encoding can replace an unpaired JavaScript
surrogate; a receipt never assumes the original string equals the encoded text.
Its fields come from interpreting that text, never from the supplied field map.
Receipt interpretation finishes before publication. After publication succeeds,
returning the receipt requires no further parsing or validation. Editors
acknowledge the decoded saved text without replacing intervening input that
encodes to different bytes.

Malformed full-source replacement can succeed with `parseError` present.
Rename checks that the supplied text encodes to its captured SHA-256 before
moving. A rename to the same path returns a receipt without touching storage;
it does not establish that the captured version still occupies that path.

Structured create and update inputs accept recursively readonly field values, so
validated snapshot values can be passed back without casts. Methods copy inputs
without freezing caller-owned objects. Updates require parsing success, validate
only supplied values, and preserve unrelated source; ADR-0464 defines their
publication baseline.

Operation errors describe acquisition, preparation, or publication. Diagnostics
describe readable source. Forward storage failure families intact. Keep invalid
UTF-8 in acquisition, invalid supplied values in preparation, unparsed current
source distinct from unsafe patching, and occupied destinations in admission.
`Conflict`, `Io`, `Partial`, and `Unconfirmed` retain their effect contracts. No
diagnostic authorizes destructive action or promises a successful save.

## Consequences

One Result answers whether the operation succeeded. One flat reading answers
what the source contains and what needs repair. Applications check the usable
fields their action requires. A missing relation cannot prove no relation
exists; operations promising complete child discovery must refuse incomplete
evidence.

Saved diagnostics describe saved text. Draft diagnostics describe the buffer.
Neither interpretation success nor an empty issue list promises history,
synchronization, rich-editor compatibility, or absence of an external edit.

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
check its presence. Typed save helpers retain schema validation, row addressing,
UTF-8 receipt fidelity, and interpretation that raw-only writes would transfer
to every application. Rename/delete wrappers also keep row-path admission and
rename receipt assembly in that same boundary.

## Implementation

[Table interpretation and commands](../../packages/folder/src/table.ts),
[shared diagnostics and value ownership](../../packages/folder/src/reading.ts),
and [public regression coverage](../../packages/folder/src/table.test.ts)
implement this shape. Todos, Whispering, Honeycrisp, and Capture consume flat
snapshots and inspect drafts through the table interpreter.
