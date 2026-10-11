# One browser admission authority

The focused composition review keeps this ownership:

```text
editor: pending input and one active publication
    -> storage: confirmed, partial, or unconfirmed file outcome
    -> folder history: one coalesced automatic obligation
    -> repository: durable incoming recovery and unfinished merge state
```

Independent Codex and Claude Opus reviews support these boundaries. Moving
history requests into the editor would exclude raw file writes and couple
history to unpublished input. Replacing request generations with a boolean
would lose newer saves during a failure or retry the failed request.

The additional deletion removes the browser backend's local mutex. The
[Web Locks algorithms](https://www.w3.org/TR/web-locks/#algorithms) already
queue requests for the same resource within and across tabs. The backend
retains cancellation normalization and checks the close signal at callback
entry. The Bun backend retains its mutex. Explicit commits still capture
independently under Git protection; incoming recovery retains its blocker.

Files read before the local post-implementation check:

```text
packages/folder/src/
|-- storage.ts, opfs-store.ts, web-locks.test-support.ts
`-- git/
    |-- history.ts, browser-backend.ts, native-backend.ts
    |-- backend.ts, mutex.ts, runner.ts
    `-- history-attempt.test.ts, history-ordering.test.ts, history.test.ts
packages/tauri-plugin-epicenter-folder/core/src/
|-- owner.rs, runner.rs
`-- history_tests.rs
apps/{todos,honeycrisp,whispering}/src/
`-- lib/status.ts and history/status components
```

The first-read, ownership, mental-inlining, and invariant checks found no
remaining correctness blocker in this follow-up. Git exclusion owns admission;
the history owner consumes request generations and records each outcome once;
storage alone authorizes a request after a confirmed complete save. Partial
and unconfirmed publications invalidate observations without requesting history.

## Verification on October 5, 2026

Coordinator commands after integration:

| Check | Result |
| --- | --- |
| `bun test --isolate packages/folder/src/git` | 94 passed |
| `bun run --cwd packages/folder typecheck` | 0 errors, 0 warnings |
| `bun run --cwd packages/folder test` | 759 core passed, 18 skipped; 14 Svelte passed |
| `cargo test --manifest-path packages/tauri-plugin-epicenter-folder/core/Cargo.toml` | 106 passed |
| `bun run --cwd packages/folder test:native` | 18 passed |

New regressions cover a save during a failing capture, a native save during a
failed branch publication, failure alone causing no retry, and close after a
lock grant but before the backend callback. The native regression uses existing
hooks and a real ref lock; it adds no production test seam.

### Committed-source verification

Codex also checked committed source at `a42574064d` in a separate clone,
without transferring dirty files. Installed dependencies were reused; internal
workspace dependencies resolved to the clone. Git tests passed all 94 cases,
native core tests passed all 106 cases, Svelte tests passed all 14 cases,
and folder typecheck found no errors or warnings.

The full folder run passed 758 cases and skipped 18. Its one failing browser
journey came from omitted dependencies of the separate `evidence/edit-handle`
harness during clone preparation. After supplying those installed dependencies,
that exact journey passed. No source change was needed. Cargo regenerated its
existing `libc` lock entry; this did not change the tested production source.

Claude completed the native regression and browser queue removal in an isolated
clone. Its sandbox could not read the dependency symlinks or cargo cache, so it
did not establish runtime acceptance. Codex compiled and ran the returned native
test in the clone and live checkout, then ran the checks above after integration.

The production OPFS acceptance app ran on a separate disposable origin,
`http://127.0.0.1:5200/`. Actual browser interactions verified:

- A final save during a held branch publication is captured by a following
  commit without another edit.
- Three saves behind another tab's Git Web Lock produce one commit of the
  final file after release.
- An explicit commit requested before a later save captures after the wait
  and returns its own outcome.
- A controlled admission failure leaves the file saved and history unchanged;
  a newer save requests history again.
- Reload preserves saved and committed bytes.
- Close while waiting returns before the other tab releases its lock. Release
  and reopen do not commit that canceled request; the saved file remains.
- After removing the local queue, cross-tab contention still ends with matching
  saved and committed files, without another save.

## Limits

These are useful checkpoints, not an audit log or a guarantee of eventual
success. Failure ends the requests covered by that attempt. A newer save can
request another attempt; closing can leave the latest saved files uncommitted.
Native snapshot acquisition briefly shares the file gate with saves, and
external in-place writes remain best effort. Browser captures can interleave
with multi-step publications; this follow-up does not redesign file snapshots.

Browser and desktop owners retain durable incomplete incoming barriers. The
Bun opener has no incoming recovery journal, as the package README already
documents. A partial Bun incoming publication can be captured by a later commit;
this existing platform limitation is not repaired by automatic scheduling.
