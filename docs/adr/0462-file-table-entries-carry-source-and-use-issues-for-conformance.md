# 0462. Table reads capture files before interpreting their contents

- **Status:** Proposed
- **Date:** 2026-10-02
- **Unbuilt:** phase-separated content Results, schema-aware draft inspection, mandatory frontmatter fences, unified per-file listings, literal destination names, narrowed operation errors, and consumer migration.

## Context

`@epicenter/folder` currently combines filename, frontmatter and field issues in
one source-backed entry. A filename problem makes every field appear partial.
Malformed YAML and invalid fields share the same variant. Editors separately
parse their current buffer and display field diagnostics from a saved entry.
Those diagnostics can describe different text.

A malformed file still exists, and saving malformed text can succeed. Putting
parsing failure in the read operation's error channel makes repair editors
extract their baseline from either an entry or a source-bearing error. Returning
only parsed entries after saves confuses interpretation with publication.

This decision changes Folder tables, not Yjs-backed reads, sparse KV semantics
or the raw byte API.

## Decision

**An entry captures a row file; its `content` Result describes interpretation.**
`get(stem)` reads `<table>/<stem>.md`. Successful acquisition and UTF-8 decoding
produce a literal path, stem, exact source and hash, even when parsing fails.
Absence is `Ok(undefined)`. Address, acquisition and decoding failures are the
outer `Err`; they are not content diagnostics.

```ts
type NonEmpty<T> = readonly [T, ...T[]];

type ParseError = {
  readonly message: string;
  readonly diagnostics: NonEmpty<{ readonly message: string }>;
};

type FieldIssue = {
  readonly field: string;
  /** JSON pointer within this field's value, when the validator identifies it. */
  readonly path?: string;
  readonly message: string;
};

type RowContent<TFields> = { readonly body: string } & (
  | { readonly fields: Readonly<TFields>; readonly issues: undefined }
  | { readonly fields: Readonly<Partial<TFields>>;
      readonly issues: NonEmpty<FieldIssue> }
);

type Entry<TFields> = {
  readonly path: string;
  readonly stem: string;
  readonly sha256: string;
  readonly source: string;
  readonly content: Result<RowContent<TFields>, ParseError>;
};

type TableListing<TFields> = readonly {
  readonly path: string;
  readonly result: Result<Entry<TFields>, TableReadError>;
}[];

// Intended signatures; current exports implement the earlier contract.
inspect(source: string): Result<RowContent<TFields>, ParseError>;
get(stem: string): Promise<Result<Entry<TFields> | undefined, TableReadError>>;
list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
```

```ts
const read = await table.get(stem);
if (read.error !== null) return showReadFailure(read.error);
const entry = read.data;
if (entry === undefined) return showMissing();

showSource(entry.source); // Same repair baseline even when parsing fails.
const content = entry.content;
if (content.error !== null) return showParseFailure(content.error);
if (content.data.issues !== undefined) {
  showFieldIssues(content.data.issues, content.data.fields);
} else {
  showDocument(content.data.fields, content.data.body);
}

// Diagnose unsaved text without inventing a saved capture.
const draft = table.inspect(buffer);
```

**`inspect(source)` parses once, then validates declared fields independently.**
This pure, synchronous method uses the compiled definition and acquires no
storage resource. Reads, mutation receipts and draft editors use this same
interpretation. Draft inspection invents no path or capture.

Row source requires an opening `---` line at the start, after an optional BOM,
and a closing `---` line. LF and CRLF remain supported. The YAML must convert to
a string-keyed mapping. An empty or comment-only block is an empty mapping.
The body is the remaining text and may be empty. Fence-less Markdown fails
parsing; it is not an instruction to insert metadata.

Missing or unclosed fences, invalid YAML including duplicate keys, non-mapping
values, non-string keys and failed alias conversion form one parse-error family.
It retains the available parser diagnostics, without fields, field issues or a
duplicate capture. Parsing failure leaves the entry's source available for
repair but exposes no partially recovered typed body.

After parsing succeeds, each declared field is checked for presence and value
conformance. `fields` contains only independently validated declared values.
Unknown keys remain in source without issues merely for being undeclared.
An unrelated failure does not remove a validated value. Validation never
coerces values, inserts defaults, cleans source or silently repairs it.

The definition compiler owns field conformance and effective constraints.
Folder does not maintain a second missing/invalid-field loop. TypeBox may
produce detail internally; reference nonemptiness, UTF-8 byte limits and
nullable behavior must agree with the value check. Public field issues carry
a self-contained message, field and optional nested pointer, not TypeBox
library types or schema paths. Messages and diagnostic counts are not machine
contracts. A pointer appears only when its producer identifies the failing value.

**Literal filenames are addresses, not conformance diagnostics.**
The table appends exactly `.md` to a single literal filename segment. It does
not trim, normalize Unicode, case-fold, strip an extension or parse an ID suffix.
Empty stems, leading dots and trailing spaces remain addresses when the backing
filesystem represents them. Empty stem names `.md`; callers must not test it by
truthiness. `.MD` files remain raw files rather than lowercase `.md` table rows.

Create and rename impose no separate portability naming grammar. Scoped path
admission still refuses folder escape, private Git paths and unsafe symlink
traversal. Actual destination identity and representability govern refusal.
A local name is not rejected because another platform could not store it.
Export or incoming adoption may refuse an unrepresentable destination.
Filename issues and application filename-conformance guards are removed.

**`list()` returns one inventory of per-file Results.**
Every enumerated direct `.md` file has one item retaining its literal path.
Readable malformed source is a successful entry with a failed content Result.
An individual read or UTF-8 failure is that item's `Err`. A file disappearing
after enumeration is individual `NotFound`, not an invented empty entry.
Enumeration or whole acquisition failure is the outer `Err`; no partial
inventory claims completeness. Listing order is not a stable sorting contract.

This replaces `{ entries, unreadable }`. Presence, selection and repair use the
same inventory. A read failure provides no editable text; raw byte access
remains available through `files` where acquisition succeeds.

**Successful publication returns captured submitted source and its interpretation.**
`create`, `update`, `replace` and `rename` return the same entry shape.
Saving malformed text can return outer `Ok(entry)` with `entry.content` an
`Err(ParseError)`. The receipt uses submitted source and its hash, not a later
read. It advances no existing capture or unsaved buffer. Conditional deletion
needs only the file capture.

`create` always writes both fences, including for an empty field map and body.
`update` validates supplied values, reads current source once, requires parse
success, patches only assigned spans and attempts one conditional publication.
It may leave unrelated field issues. A parsed document can still be unsafe to
patch without losing source: that is a preparation refusal. Neither parse
failure nor patch refusal triggers an implicit rewrite. Whole-source `replace`
saves exact UTF-8 text even when malformed. Publication follows ADR-0464 and
ADR-0477; source and hash always describe the same captured bytes.

**Operation errors describe acquisition or publication; diagnostics describe interpretation.**

| Family | Cases and owner |
| --- | --- |
| Absence | Direct `get`: `Ok(undefined)`; missing update input: `NotFound`; disappeared captured replacement: `Conflict`. |
| Read and enumeration | Invalid scoped address, non-file/non-directory target, I/O, closed owner, transport outcomes, and invalid UTF-8 when decoding. Expose only reachable variants per method. |
| Parsing | Required framing, YAML syntax and mapping/conversion failures. One content `ParseError` with diagnostics; no field issues. |
| Field conformance | Missing or invalid declared values after parsing. Flat issues alongside independently validated fields. |
| Write preparation | Invalid or uncopyable supplied values, unparsed current source, unsafe source patch. No bytes published. |
| Destination admission | Occupied destination or a path the actual destination cannot represent. Operation errors, never entry issues. |
| Publication | `Conflict`, `Io`, `Partial`, `Unconfirmed` and closed/transport outcomes retain their actual effects and uncertainty contracts. |

Reuse the file occupied-destination error instead of duplicating `Exists` in
table and file namespaces. Table stem-address refusal uses shared scoped-address
failure instead of overlapping `InvalidStem` and `InvalidPath`. Put UTF-8
failure in the read family, not the union of all table write errors. Uncopyable
supplied fields belong to invalid-input preparation, not source-patching failure.
Keep parse-dependent preparation refusal distinct from unsafe patching of
successfully parsed YAML. Do not merge `Conflict`, `Partial`, `Unconfirmed` or
I/O into a generic failure. Narrow method-specific error aliases against actual
adapter outcomes, including transport uncertainty where reachable.

## Consequences

- Parsed and unparsed files have one repair baseline and save receipt. Captures
  and source remain inspectable after close; further folder operations refuse.
- Consumers branch on `content` before using fields or body. Whole-row consumers
  additionally narrow on `issues`. Limited actions check their actual validated
  inputs, not universal entry conformance.
- Draft diagnostics describe the buffer; saved diagnostics describe the saved
  capture. One interpreter removes schema-free draft guards and merging issues
  from different text generations.
- A missing validated relation cannot prove absence of that relation. Deletion
  promising to find every child must refuse incomplete evidence or narrow its
  promise. Diagnostics do not authorize destructive action.
- Mandatory framing removes body-only typed edits on malformed YAML. Source
  replacement remains available. Rich-editor admission is a separate check.
- A save promises neither parsing success, historical retention nor delivery.
  Native publication retains its best-effort limits against external writers.

## Considered alternatives

| Candidate | Benefit | Cost and judgment |
| --- | --- | --- |
| Flat entry with mixed issues | Short partial-field access. | Parse state is inferred from body availability and issue kinds. Rejected for the phase-separated contract. |
| Flat three-state entry union | No content wrapper; fewer caller changes. | Empty partial fields also mean never parsed; absent body doubles as parser discriminant. Viable, but explicit parsing Result is preferred. |
| Parse failure in the outer read error | Only parsed documents are entries. | Source-bearing errors become parallel repair baselines; malformed saves need another receipt or reconstruction. Rejected. |
| Capture plus content Result | Same baseline and receipt regardless of parsing; one pure interpreter. | Adds one content branch and property access. Chosen. |
| Raw files plus interpreter only | Fewer table methods. | Apps rebuild discovery, decoding, absence and composition. Rejected. |
| Always-partial fields | One entry variant. | Shifts complete-field checks into callers. Rejected. |

Before runtime migration, exercise malformed selection and save, current-draft
inspection, independently valid action inputs, literal odd names, invalid UTF-8,
individual listing failures, disappearance and stale replacement. Verify nested
TypeBox diagnostics against the locked dependency before producing pointers;
do not infer partial field validity from whole-object error paths.
