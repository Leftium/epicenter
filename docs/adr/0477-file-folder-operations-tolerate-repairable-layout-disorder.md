# 0477. File-folder operations tolerate repairable layout disorder

- **Status:** Proposed
- **Date:** 2026-10-01
- **Relates:** [ADR-0480](0480-file-tables-own-only-their-markdown-row-files.md) proposes row-only operations without inferred attachments; [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md), [ADR-0464](0464-file-table-updates-conditionally-replace-the-captured-whole-file.md), [ADR-0467](0467-file-workflows-report-each-operations-outcome.md), and [ADR-0474](0474-incoming-git-adoption-retains-a-recoverable-plan.md) state the per-operation rules this layout promise bounds.
- **Implementation:** row-only operations and intent-based mutations in Folder. `create`, `rename`, and a batched row read the table directory once before publication and refuse a destination a file occupies at that exact name, as the files' `Exists`. No portability naming policy and no case or Unicode folding applies: a filesystem that holds one file for two spellings refuses the second through the publication's exclusive destination condition. Todos, Honeycrisp, Whispering, and Capture are on this contract.
- **Unbuilt:** the same destination coverage against the desktop Rust owner, which was not run for this change.

## Context

The experimental file folder's earlier publication contract checked directory
layout twice. The desired contract permits partial operations and layouts a
person or agent can repair.

`table.create`, `table.rename`, and `table.delete` in
`packages/app/src/files/table.ts` built a `DirectoryCheck` over the table
directory's filenames. `preflight` ran it once to refuse early. The same check
then travelled as a `DirectoryGuard` through `publish(changes, guard)` in
`packages/app/src/files/folder.ts` to `FileBoundary.apply(changes, guard)`, which
ran it again where the batch published. The browser adapter ran the guard
inside its IndexedDB readwrite transaction. The native adapter ran it inside
its batch queue, which orders that one boundary's batches only: another program
can add a sibling after the check. The planned Rust adapter of
[ADR-0476](0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md)
cannot receive a JavaScript callback. Retaining the callback's condition in Rust
would require sending observed directory membership across IPC, comparing it at
publication, and retrying on a mismatch.

Layout disorder is accepted whether another program causes it or two of the
app's own operations race. The native filesystem cannot isolate publication
from arbitrary external editors.

## Decision

**Destination layout checks run once before publication.**
Creation and rename refuse observed occupied destinations and spellings the
actual destination filesystem cannot distinguish. A case-sensitive filesystem
may retain distinct case spellings. Literal names incur no extra portability
conformance check under ADR-0457 and ADR-0462.
These checks use a directory reading and do not isolate native publication from
other programs. The proposed single-file row contract removes sibling ownership
checks; row deletion needs its captured file baseline, not a directory scan.

**Publication checks per-file conditions and nothing about siblings.**
The internal `FileChange` carries an explicit operation and a captured
`expectedSha256` where required. The public intent methods in ADR-0479 retain
that operation through publication.

| Step | Condition at publication |
| --- | --- |
| Create file or row | Destination absent. |
| Replace captured file or row | Current bytes match the captured hash, including unchanged writes. |
| Move captured file or row | Source matches the captured hash; destination absent. |
| Remove captured file or row | Current bytes match the captured hash. |
| Deliberate overwrite | No captured-byte condition. |

A related-file operation names each selected path and its condition explicitly.
A reference or same-stem spelling does not authorize moving or deleting media.
Consumption keeps ADR-0466's separate captured-byte contract.

The Rust adapter of ADR-0476 still validates scoped paths, every per-file
condition, and exclusive destinations. Commands use generated Tauri bindings.
It ports no directory-membership comparison or membership retry.

**Disorder that appears after preflight is reported or left for repair.**
A later collision or file change can stop an ordered native publication after
some steps. Two related-file creates can leave independently saved media when
the row creation collides. Those bytes remain ordinary source; they do not make
the existing row ambiguous or authorize cleanup. Browser adapters publish a
batch in one transaction and may stay stronger; they are not weakened to match
native partial results.

**Native outcomes report known effects and uncertainty.** The native boundary
keeps its one-at-a-time batch and capture queue, so a capture never sees one of
its own batches half applied.
`Conflict`, `Io`, `Partial`, and `Unconfirmed` are returned as they occurred. A
caller that still holds audio or a draft keeps it whenever publication failed or
is unconfirmed. No layer swallows a failure or blindly retries destructive,
partial, or `Unconfirmed` work. A renewed attempt observes current source and
must account for the uncertain earlier outcome, as ADR-0467 requires.

Native conditions remain best effort against other programs. A write that lands
between the final version check and the `rename` or `unlink` can be replaced or
removed. Those bytes can be unrecoverable without another retained copy. Git
repairs only bytes it retained.

Incoming updates use ADR-0474's separate Git-owned record: retain the before
and after commits, refuse mixed checkpoints, and explicitly roll forward only
over expected path states. Unrelated app edits remain available. This does not
retain every uncommitted version or authorize overwriting outside edits.

The layout rule removes these mechanisms:

| Deleted                                                                | Former owner                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DirectoryGuard` and the `guard` parameter of `FileBoundary.apply`     | `packages/app/src/files/boundary.ts`                                                |
| Guard evaluation in `applyInTransaction` and in the native `apply`     | `packages/app/src/files/browser-store.ts`, `packages/app/src/files/native-store.ts` |
| The `guard` parameter of `publish`                                     | `packages/app/src/files/folder.ts`                                                  |
| The second run of `DirectoryCheck` in `create`, `rename`, and `delete` | `packages/app/src/files/table.ts`                                                   |
| Exact directory-membership compare and retry in the Rust adapter       | never built                                                                         |

## Consequences

- Destination checks use one directory reading. The Rust adapter receives file
  steps and conditions only, with no membership payload.
- A related-file save can leave media without its intended row after a partial
  publication. Current paths remain inspectable; callers retain uncertain input
  and reconcile before another attempt.
- Source access stays available when metadata or links are invalid. Layout
  disorder does not authorize cleanup or choosing media on a person's behalf.

## Considered alternatives

- Keep `DirectoryGuard` and port exact membership comparison to Rust. External
  writers can still race it; the extra IPC, comparison, and retry path does not
  establish native isolation.
- Discover and mutate same-stem attachments: duplicates application relationships
  and acts on media without a captured byte baseline.
- Remove rename entirely: discards the explicit readable-stem operation used by
  Todos, while single-file rename needs no media ownership machinery.
