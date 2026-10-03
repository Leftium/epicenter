# 0479. File mutation methods express publication intent

- **Status:** Proposed
- **Date:** 2026-10-01
- **Implementation:** flat SHA-256 captures and explicit operations across the TypeScript and Rust backends.
- **Unbuilt:** operation-specific interrupted-move outcomes and production canonical editor integration.

## Context

The former `FolderFiles` API exposed
`write(path, content, { expected })`, `remove(path, { expected })`, and
`move(from, to, { expected })`. `FileExpectation` combines exclusive creation,
comparison with captured bytes, and unconditional publication in one argument.
Editors repeatedly pass a baseline version; new-file callers pass `'absent'`.
The table API already receives a captured entry for edits.

The underlying conditions prevent cooperating writers from overwriting stale
input. The public API can express the caller's intention without requiring
callers to construct those conditions.

## Decision

**File methods select publication conditions through their verbs and targets.**

| Method | Publication condition | Successful result |
| --- | --- | --- |
| `create(path, content)` | The destination is absent. | A capture of the published file. |
| `read(path)` | Read the file's bytes and capture their identity. | A captured file. |
| `replace(file, content)` | Current bytes match the supplied capture. | A new capture of the published file. |
| `remove(file)` | Current bytes match the supplied capture. | Removal completed. |
| `move(file, destination)` | Source bytes match the capture; destination is absent. | A new capture at the destination. |
| `overwrite(path, content)` | Replace or create at the literal path without a captured baseline. | A capture of the published file. |

`content` is `string | Uint8Array`. Strings are encoded as UTF-8 without newline,
BOM, frontmatter, or format normalization. Byte arrays are copied at admission
before asynchronous preparation and saved exactly. No filename extension
selects a different encoding or lifecycle.

**A captured file is a plain value containing `{ path, sha256 }`. The hash is its fixed content baseline.**
`read` also returns detached bytes. Mutation targets need only the path and
baseline, so an operation need not retain the payload array. The baseline is
independent of later changes to that array. Captures acquire no lease, host
registry entry, signal, or disposal obligation. Successful mutations return new
captures; they never advance an existing capture underneath an unsaved draft.
The representation must support browser/native transport and comparison needed
for publication reconciliation, without requiring routine callers to extract
hashes or assemble `expected` arguments.

**Conditional edits keep the caller's captured baseline until publication.**
The implementation does not substitute a fresh read, merge changes, replay a
callback, or silently retry after conflict. A stale capture reports conflict.
Identical content does not prove which actor wrote it; an occupied destination
is not automatically accepted as an idempotent `create`.

Internal `FileChange` preserves the operation all the way to publication:
`create`, `replace`, `overwrite`, `remove`, or `move`. `replace` requires
`expectedSha256`. Captured removal and movement carry the same hash; shell
removal and movement can omit it. Both still require a source, and movement
always requires an absent destination. `FileExpectation` is removed.

Creation at an occupied destination reports `Exists`; a failed hash guard
reports `Conflict`. File size is not part of the captured identity. Native
checks remain best effort against arbitrary external programs. A move can
create its destination and fail to retire its source; its operation-specific
outcome must report that fact. Ordinary writes expose no generic multi-file
`Partial` result. An unconfirmed response remains unknown, and a caller
inspects current files before renewing an uncertain operation.

A canonical table editor chooses `overwrite` for every save. Its comparison
baseline determines dirty state and how observations affect the local draft;
it does not guard publication. Saving replaces the complete canonical document
at the fixed path and can recreate a file another writer removed.

`open(path)` remains the stable-byte consumption API. It needs no editing
baseline. A bytes-free observation method for large-file mutations is deferred
until a caller or measurement justifies it.

All successful file mutations use the opened folder's history policy, as table
and KV saves do. Save success remains separate from commit and push success.
Methods and returned captures do not promise per-save historical retention.

## Consequences

- Exclusive creation and captured replacement have separate names and error
  intentions. Common callers stop importing `FileExpectation`.
- `overwrite` preserves deliberate shell redirection without disguising it as
  a conditional edit.
- Moves act on the reviewed file, not a replacement that appeared at its path.
  Moving a file does not repair links elsewhere.
- The captured-file representation must remain serializable and comparable;
  moving mutation methods onto live file objects would add unnecessary lifetime
  and bridge requirements.

## Considered alternatives

- Keep one write method with optional conditions: omitted conditions make a
  stale editor's save unconditional.
- Reread immediately before saving: a draft based on older source can still
  overwrite the newer source.
- Replay an updater callback against new bytes: introduces merge and callback
  repeatability requirements absent from ordinary file saves.
