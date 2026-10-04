# 0503. File-authoritative workflows preserve information and tolerate repairable states

- **Status:** Proposed
- **Date:** 2026-10-04
- **Relates:** [ADR-0477](0477-file-folder-operations-tolerate-repairable-layout-disorder.md) and [ADR-0482](0482-folder-mutations-publish-one-file-at-a-time.md) establish repairable layouts and independent file operations.
- **Unbuilt:** Applying this review criterion to application refusals and choosing simpler folder-deletion behavior in Honeycrisp.

## Context

Epicenter stores ordinary files so a human or coding agent can inspect what
happened and repair it. That access should shape the guarantees we pursue.

The folder API keeps malformed row text accessible, reports field issues,
and patches assigned fields without reconstructing the whole file from a
partial reading. Applications can still accumulate checks aimed at preventing
inconsistent relationships. Honeycrisp refuses folder deletion when any note's
folder cannot be read, then clears each member note's `folderId` before removing
the folder. Another program can change those relationships afterward anyway.

A malformed file or dangling reference can be corrected with another edit.
An overwritten draft or discarded field cannot be recovered unless some
version retained it. Those failures deserve different protection.

## Decision

**File-authoritative workflows tolerate visible inconsistencies that a human
or coding agent can repair with another edit.**
The review question is: "If this goes wrong, will a human or coding agent have
enough information to understand and repair it?" Source must remain accessible,
the problem must be discoverable, and correction must not require reconstructing
erased intent. An application permits work that does not depend on the broken
data. Repair need not restore the previous state: reassigning a note whose
folder was deleted can be a sufficient correction.

**Edits protect information from accidental loss.**
Change only what was requested, retain unrelated source, and keep unsaved input
when publication fails or remains unknown. Keep per-file conditions and
exclusive destinations that prevent accidental replacement. Refuse a structured
patch when locating the change requires guessing or discarding source; keep
raw-text repair available. Intentional deletion and whole-file replacement
retain their explicit contracts.

**Partial workflows leave completed edits saved and report their outcomes.**
Distinguish success, refusal, and uncertainty. Before adding a refusal,
transaction, rollback, or recovery mechanism, name the information it protects
and the repair path without it. Remove machinery whose only purpose is
preventing a repairable inconsistency once visibility and repair are established.
A human or agent may need to make a later correction; that effort is part of
the tradeoff.

## Consequences

The first application is Honeycrisp folder deletion. All Notes already includes
notes whose folder is missing; the note editor shows the missing ID and offers
reassignment. Verify that path after reopening before simplifying deletion.

Prefer evaluating deletion of only the folder file: note references and drafts
stay untouched, and restoring the same folder ID restores membership. Compare
that with the current reassignment to `null`, which clears membership. Reusing
an old ID for a different folder would also reattach those notes. Choose and
state the intended behavior before changing the operation and its dialog.

This record introduces no new runtime contract. Structured `create` and
`update` still validate supplied values, and `table.edit` still requires a
canonical, conforming row. Raw-text operations provide the broader repair path.
Git preserves versions actually captured by commits; an automatic commit
request does not establish a retained copy. Path, credential, and Git
publication protections keep their existing owners.

Tests for a simplified workflow should establish that problematic source stays
accessible, unrelated work continues, drafts survive, and a later edit repairs
the state. The next slices live in [the backlog](../../BACKLOG.md#apply-repairability-to-file-authoritative-workflows).

## Considered alternatives

- Prevent every inconsistent relationship: adds coordination that outside
  writers can invalidate.
- Rely on an agent to fix any failure: an agent still needs source and evidence.
- Treat Git as universal rollback: versions never captured remain unrecoverable.
