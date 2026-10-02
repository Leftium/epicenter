# 0464. File table updates conditionally replace the captured whole file

- **Status:** Proposed
- **Date:** 2026-09-30
- **Implementation:** current-source `update` and captured `replace` through the shared browser/native file boundary, with no automatic retries.
- **Unbuilt:** migration of released editors and native integration beyond the demo.

## Context

A checkbox assigns one field, while a document editor submits complete source
that began from a captured baseline. Requiring both callers to supply an entry
makes an unrelated change since a listing reject a checkbox command. Treating
both as current-content assignments instead lets a stale document erase
changes it never presented.

Tables interpret and prepare Markdown over the same file publisher as raw
file operations. The API must distinguish these intentions without a second
storage mechanism, a target-dependent overload, or retry settings.

## Decision

**Structured commands read current source; complete replacements use the caller's capture.**

| Method | Preparation and baseline |
| --- | --- |
| `update(stem, { fields?, body? })` | Read current source once, validate supplied fields, and patch only requested fields/body. Publish against that read's SHA-256. |
| `replace(entry, source)` | Encode complete supplied UTF-8 text and publish against the entry's SHA-256. Invalid frontmatter is saved and reported in the returned entry's issues. |

The stem is one literal filename segment under the table's directory, not a
path. Updates accept existing external names under the same addressing rules
as `get`, even when they violate creation's naming rules. A missing row returns
`NotFound`; an update never creates a row. An entry supplies its literal path
and SHA-256 to `replace`, so no separate path is required. Neither
method changes the row stem or moves other files.

`update` captures supplied field values and body before its first wait. It
preserves current unrelated source, including unknown keys, comments, quoting,
ordering, byte-order marks, and untouched newline spans. A field-only update
does not reserialize the body. Validation of a supplied field does not require
unrelated stored fields to conform. Source that cannot be patched safely is
refused without writing. A body assignment replaces the body deliberately;
it does not merge another writer's body edits.

`replace` saves the supplied text exactly. It neither patches frontmatter nor
requires it to conform to the table schema. This permits complete-source repair.
An editor adapter owns the mapping from its widget to the text being submitted.

**Each call makes one conditional publication attempt and never retries.**

Both methods use one publisher. Its whole-file SHA-256 check is the
publication condition, even for a single-field assignment. A change before an
update's read is incorporated; a change between that read and publication
returns `Conflict`. Changes since an editor captured an entry can refuse its
`replace`. A conflict wrote nothing. An application can narrow the error by
`error.name` and decide whether to reread, ask for review, or issue a new command.

`Conflict` names a failed publication expectation; `NotFound` names absence.
For an update, absence at its read is `NotFound`; disappearance between read
and publication is `Conflict` with `actualSha256: undefined`. These names do not
assert which writer acted or when. Missing-source removal and movement retain
their existing `NotFound` behavior. Unknown outcomes remain `Unconfirmed`.

No operation silently substitutes another baseline after conflict. An unchanged
write still checks its condition. `Unconfirmed`, partial progress, I/O failures,
and thrown calls never trigger automatic replay. No retry count or transform
callback is exposed.

Success returns a new immutable entry interpreted from the exact submitted
bytes and their hash. It is not a later reread and does not mutate an entry
passed by the caller. Table updates and replacements check no sibling filenames
and infer no attachment ownership. Creation and rename own destination layout
preflight under
[ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md).

**The file boundary owns publication for structured and raw saves.**

Browser managed writers compare and publish transactionally. Native checks are
best effort against arbitrary external programs: a hash check followed by
rename is not an operating-system-wide compare-and-swap. The table adds source
preparation and receipt interpretation to the same condition used by
`files.replace(capture, content)`.

Both replacement methods take a capture containing its path. The table helper
also checks that it identifies a row of this table and returns interpreted
fields, body, and issues for the submitted text. Capture's draft UI consumes
that interpretation; replacing the helper with raw files would transfer
parsing into the application or require a racing post-save observation.

File-save success remains independent of Git history. Commit and push failures
do not undo a save or change its returned entry. No editor flush or pending-ref
journal is required solely to complete history.

## Consequences

- A checkbox command preserves an external title edit saved before its read.
  Assigning the same field can supersede that field's earlier value by design.
- A captured document save refuses any intervening whole-file change, including
  one to an unrelated field. The application chooses what to do with its draft.
- Concurrent commands can return conflicts even on one handle. The library
  promises no click ordering or completion under continuous contention.
- A captured structured patch is no longer an `update` mode. An editor can
  prepare its captured source with `patchSource` and save it through `replace`;
  `patchSource` does not itself perform table field validation.
- Rename and delete retain captured targets. The `kv.update(snapshot, values)`
  contract remains captured, including exclusive initialization from absence.

## Considered alternatives

- Retry definite conflicts internally: tolerates more races but adds another
  read/publication attempt and a retry-bound decision. Callers receive the error.
- Retry without a bound: an operation can remain pending under continual writes.
- Keep captured-only structured updates: unrelated changes since listing reject
  common field assignments and push fresh-read composition into applications.
- Overload `update` on a stem or entry: makes target shape select the policy and
  retains two structured-update modes.
- Use complete-source overwrite for every save: stale buffers can erase changes
  they never observed. Explicit `files.overwrite` remains available to apps
  deliberately choosing that behavior.
