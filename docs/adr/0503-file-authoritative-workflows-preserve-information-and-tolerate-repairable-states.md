# 0503. File-authoritative workflows preserve information and tolerate repairable states

- **Status:** Proposed
- **Date:** 2026-10-04
- **Relates:** [ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md) and [ADR-0482](0482-folder-mutations-publish-one-file-at-a-time.md) establish repairable layouts and independent file operations. Source-preserving readings are implemented in [the row reader](../../packages/folder/src/row-text.ts). This record generalizes their design judgment without replacing their operation contracts.
- **Unbuilt:** Consistent application diagnostics for broken relationships, simplified relationship workflows, and a settled conformance policy for structured writes. The existing folder API and callers retain their current behavior.

## Context

Epicenter keeps Markdown rows, `kv.json`, and ordinary media files as saved
data so a human or coding agent can open them, understand what happened, and
repair them. That access should shape the guarantees applications pursue.

The folder API already preserves malformed row text, reports field issues,
permits raw-text replacement, and publishes individual file operations.
`table.update` patches assigned fields while retaining unrelated source.
References can dangle, and a row does not own a same-stem media file.

Applications can nevertheless accumulate checks intended to prevent every
inconsistent relationship. Honeycrisp's `folderDeletionProblem` checks listed
notes, open drafts, raw-text sessions, and pending operations before deletion.
Those checks cannot exclude another program changing the folder afterward.
Todos similarly refuses saves while earlier outcomes remain unsettled; some
of those refusals protect a draft, while others may only preserve workflow
consistency. Each needs to be judged by what information it protects.

An invalid field, malformed frontmatter, or missing referenced folder can be
repaired when the source remains available. An overwritten draft or discarded
unknown field may remove the evidence needed to repair anything.

## Decision

**File-authoritative workflows make best-effort edits and tolerate intermediate
states that a human or coding agent can inspect and repair.**
The review question is: "If this goes wrong, will a human or agent have enough
information to understand and repair it?" A repairable state has accessible
source, a discoverable problem, and an explicit correction that does not need
to reconstruct erased intent. The mere possibility of an agent does not
establish those properties.

**Preserving information takes priority over maintaining perfect relationships.**
Edits preserve unrelated text, unknown fields, and unsaved input. Per-file
conditions and exclusive destinations still protect against accidental
replacement. A structured patch refuses when it cannot locate the intended
change without guessing or discarding source; raw-text editing remains the
repair path. Transactions and recovery records earn their cost when they
protect otherwise lost information or a necessary storage/history boundary.

**Diagnostics describe imperfect source without hiding it or blocking unrelated
work.**
`table.get`, `table.list`, and `inspectRow` retain their distinction between
acquiring text and interpreting it. Applications keep problematic files
accessible as text. An action requires the fields it uses, rather than proof
that every field conforms. Invalid relationships belong to app diagnostics;
the folder package does not infer ownership or rewrite references.

**Related-file workflows report their progress and leave completed edits saved.**
A workflow attempts its named operations under their individual conditions.
Failure leaves earlier effects inspectable. Callers distinguish confirmed
publication, refusal, and uncertainty, retaining input when its publication is
unknown. Repair is another explicit edit against observed source. No automatic
rollback, destructive retry, reference cleanup, or deletion of orphaned media
follows merely from discovering an inconsistency.

**Saving, conformance, history, and synchronization are separate outcomes.**
Malformed text can be saved through raw-text operations and retained in Git as
bytes. Schema diagnostics alone do not justify preventing those operations.
Structured `create` and `update` currently validate supplied values; changing
that admission policy requires a concrete public API decision. Synchronization
does not repair data by itself, and neither Git nor an agent can recover a
version that nothing retained. Existing path, storage, credential, and Git
publication constraints remain applicable.

## Consequences

Apps can permit malformed rows and broken relationships while continuing useful
work. They must make those states visible and provide a direct repair path.
Diagnostics should be derived from current files so reopening or transferring
the folder does not depend on an old window's memory of the failure.

Honeycrisp folder deletion is the first candidate: make missing-folder notes
visible and repairable, then reduce checks whose sole purpose is preventing
dangling `folderId` values. Preserve checks that protect open drafts or newer
file bytes. A failed note reassignment need not imply undoing earlier ones.

Tests should establish that failures preserve source and input, expose the
problem, permit unaffected work, and allow a later correction. Tests whose only
purpose is forbidding a now-permitted intermediate state change with that
contract. The implementation sequence lives in [the backlog](../../BACKLOG.md#apply-repairability-to-file-authoritative-workflows).

## Considered alternatives

- Prevent every inconsistent relationship: adds checks and coordination while
  outside writers can still invalidate the result.
- Accept errors because an agent can fix them: omits the source preservation
  and diagnostics that make repair possible.
- Treat Git as universal rollback: automatic commit attempts can be skipped,
  and unretained versions remain unrecoverable.
