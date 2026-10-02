# 0486. Folder domain methods share accounted storage

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

Folder methods received raw storage alongside a separate publication function.
A helper could apply changes through either route, even though every local
content save needed the same history and change-hint accounting. Whole-helper
admission also made close responsible for reads, preparation, hashing, and
publication replies that already had their own completion promises.

## Decision

Domain factories receive one structured dependency object:

```ts
createFiles({ storage })
createTable({ storage }, { definition })
createKv({ storage }, { definition })
createTerminal({ storage, git }, options)
```

Browser and Bun openers attach content-save accounting to `storage.apply`.
Complete nonempty applications mark history stale, request one automatic
commit, and announce changed paths. Partial applications mark history stale
and announce only known applied steps. Refusals and uncertain outcomes remain
unchanged. Directory operations do not request content history.

The native owner already performs this accounting. Its opener supplies that
storage directly. Assembly fences the next backend call with the handle's
close signal. Domain methods receive neither raw storage nor a separate
publication function. Git retains raw storage because an incoming fast-forward
has its own file, index, branch, and notification sequence.

Each file operation's promise owns completion. Close fences new storage calls,
stops observations and network work, drains owned Git work, and releases the
attachment. It does not wait for file helpers. A helper still preparing can be
refused before its next backend call; an application already started returns
its actual outcome. A batch remains one application with backend-specific
atomicity or ordered partial progress.

## Consequences

`FolderContext`, helper admission, its pending Set, `settled`, and the shell's
separate forwarding API disappear. Publication policy is attached once at the
opener, so Tauri needs neither a publication mode flag nor no-op accounting
methods.

Apps await saves they intend to preserve before intentional quit. Editors own
submitted saves; app commands and imports own their whole operations. The
library does not recreate that ownership through a generic pending registry.
A browser application finishing after close may lose its cross-tab hint because
the notification channel has closed. Git and native owner shutdown retain
resource drains; those protect different lifetimes from file-helper completion.

## Considered alternatives

Keeping separate storage and publication dependencies leaves a bypass around
local-save accounting. Putting accounting inside every raw adapter would treat
incoming Git changes as new local saves and duplicate native-owner effects.
A per-call origin or skip-history flag makes every caller choose construction
policy. Whole-helper admission preserves a stronger close barrier by retaining
an additional operation registry; callers instead await their own operations.
