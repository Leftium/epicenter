# 0474. Incoming Git adoption retains a recoverable plan

- **Status:** Proposed
- **Date:** 2026-10-01
- **Relates:** [ADR-0467](0467-file-workflows-report-each-operations-outcome.md) separates ordinary workflow outcomes; [ADR-0468](0468-file-saves-succeed-independently-of-automatic-commits.md) separates saves and history; [ADR-0471](0471-a-data-folder-handle-exposes-tables-kv-and-files.md) defines folder ownership.
- **Unbuilt:** durable incoming records, pinned commit retention, explicit recovery and application presentation across browser and native backends.

## Context

Incoming adoption replaces authored files, changes the staging index and moves
HEAD. Independent OPFS or native writes can stop between these changes.
Checkpointing that mixed tree can create divergence from the fetched target.
A later fetch can move the tracking ref and lose the original recovery target.

Ordinary app saves need no general journal. Incoming Git adoption needs enough
repository-owned evidence to identify an interrupted plan and retain its bytes.

## Decision

**Incoming adoption retains a Git-owned record before changing the working tree.**
The record resides inside `.git/` and identifies the before and after commits,
expected branch and operation identity. Recovery derives file changes from
those commit trees instead of duplicating their bytes in the record. Private Git refs pin both commits while the
record exists. The target survives tracking-ref changes and garbage collection.
A repository without a before commit records that absence explicitly.

**Fetch and adoption remain explicit separate actions.**
`git.fetch()` transfers objects and updates remote-tracking refs without changing
authored files. `git.pullFastForward()` evaluates the fetched target and requires
clean portable files, a clean staging index, supported literal paths and a target
that descends from local HEAD. A prepared divergent merge, if separately exposed,
uses the same recovery boundary; this decision adds no automatic merge policy.
Opening, focusing, refreshing or pushing does not start or replay adoption.

**Recovery rolls forward only over the recorded before or after content.**
For each affected path, compare current bytes or absence with the corresponding
before and after tree entries. If already at the after state, skip the file. If
still at the before state, perform the planned conditional change. Any other
content stops recovery and identifies the path requiring review. Check directory
and filename collisions too. Never roll back over later edits or infer absence
means that another writer's file can be removed.

After files satisfy the target tree, publish the target index and replace the
branch through compare-and-swap against the recorded expected HEAD. Recovery
recognizes already-completed index and branch phases. A competing index or branch
change stops recovery; it is not overwritten from the old plan. Native index
publication uses Git's lock protocol. Clear the record and release commit pins
only after the completed state is verified.

If the branch already names the target commit, publication finished before
record cleanup. Clear the completed record without replaying authored files,
then observe current status. Those files can have newer edits. An empty file
at a path that was formerly absent is a third state when the target is nonempty;
recovery cannot distinguish a crash-created entry from a later external edit.

**Interrupted adoption blocks mixed checkpoints, while ordinary editing remains available.**
A stopped or unknown attempt retains its record. Git commit and new incoming
adoption refuse while recovery remains unresolved; fetch can still retain a
new remote observation without changing the pinned target. Apps may save files,
but edits to affected paths can require reviewed resolution before recovery.
Startup and status report pending recovery. Resumption requires an explicit
action and evaluates current files and repository state again.

## Consequences

A process interruption cannot silently become an ordinary mixed-tree commit.
The original before and after bytes remain available for review. Recovery adds
one bounded repository-owned record and commit retention; it does not make a
multi-file working-tree transition atomic or back up every app save.

Outside writers remain possible. Their changes can stop safe roll-forward and
require manual resolution. The record must survive unknown file, index and
branch replies without treating current content as proof of a particular reply.

## Verification

Interrupt before and after record publication, every file change, index
publication, branch replacement and record clearing. Reopen, expose the pending
state, and explicitly resume. Verify moved tracking refs retain the target;
modified paths, index and HEAD refuse stale recovery; commits refuse a mixed
tree; and matching completed phases are skipped. Cover an initially empty
repository and invalid authored Markdown without generated conflict markers.

## Considered alternatives

- Record no incoming plan: later checkpoints can create divergence and fetch can
  stop retaining the target needed to finish adoption.
- Journal every app save: extends incoming-specific coordination to unrelated work.
- Replay automatically at startup: can replace current files without review.
- Roll back the old tree: can overwrite edits made after the interruption.
