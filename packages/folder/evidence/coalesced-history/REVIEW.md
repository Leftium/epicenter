# Final local review

Files read before analysis:

```text
apps/
|-- honeycrisp/README.md
|-- honeycrisp/src/lib/platform/notes-host.browser.ts
|-- capture/README.md
`-- whispering/ARCHITECTURE.md
packages/folder/
|-- README.md
|-- package.json
`-- src/
    |-- storage.ts
    |-- tauri-adapter.ts
    |-- browser.ts
    |-- native-store.ts
    |-- git/
    |   |-- history.ts
    |   |-- backend.ts
    |   |-- browser-backend.ts
    |   |-- native-backend.ts
    |   |-- mutex.ts
    |   |-- messages.ts
    |   |-- history-attempt.test.ts
    |   `-- history-ordering.test.ts
    `-- native/bindings.gen.ts
packages/tauri-plugin-epicenter-folder/
|-- README.md
|-- core/src/
|   |-- owner.rs
|   |-- history_tests.rs
|   |-- publication_tests.rs
|   `-- registry.rs
`-- src/
    |-- commands.rs
    `-- tests.rs
docs/adr/
|-- README.md
|-- 0468-file-saves-succeed-independently-of-automatic-commits.md
|-- 0469-generated-commit-messages-describe-captured-file-changes.md
|-- 0488-cloud-folders-use-independent-git-histories.md
|-- 0489-cloud-folder-transfers-are-explicit-and-bootstrap-before-opening.md
`-- 0505-automatic-commits-carry-one-coalesced-request-until-the-folder-is-free.md
```

The save caller publishes complete files, marks history stale, then requests
history. Browser and Bun handles own their worker; desktop publication and
history share the Rust owner. No editor payload crosses into the scheduler.
Two request generations distinguish admission failures from newer successful
saves. Each whole-folder checkpoint consumes the current generation before
awaiting blocker checks or capture. A staged checkpoint remains a different
operation and preserves staged intent.

The new worker boundaries earn their place: TypeScript owns cancellation and
bounded awaited work; Rust owns request insertion under the file gate and
atomic worker retirement under a leaf mutex. The existing backend owns Git
protection. The nonblocking admission branch, mutex tryRun, browser
ifAvailable use, and per-save native admission channel disappear.

Independent cumulative Codex review found a native spawn-failure ordering bug.
The failure receipt now precedes retirement of its worker slot, so a newer
worker cannot publish a successful receipt that the older launch overwrites.
The clone's old code is retained as review evidence; the integrated code and
native tests contain the correction.

A fresh Claude review proposed native panic recovery and retaining automatic
intent after a refused explicit commit. Neither changes this task's direction.
Observer panics already break public owner methods and destructor delivery;
resetting one scheduler flag would not establish recoverable ownership. An
explicit failure retires only requests made before it asked for protection,
so the failed checkpoint remains visible rather than immediately retrying the
same saved state. Newer completed saves remain eligible.

Browser capture is not fenced against every save. A save racing an admitted
checkpoint can be included in that tree and still authorize a later unchanged
pass. This costs bounded work and creates no empty commit. Rust numbering and
capture are exact under the shared file gate. Bun's per-handle protection does
not turn arbitrary external Git lock files into a waitable availability API;
those failures stay visible and require a newer save or explicit checkpoint.

The shared direction separates three actual owners: editor pending text,
folder pending history, and Git's durable unfinished merge state. The merge
testbed keeps its conflict-leave operation manual-history only and preserves
whole-folder blockers. No timer, transport dependency, persistent request
queue, or extra editor copy is needed.

Verification and actual UI evidence are in [ACCEPTANCE.md](ACCEPTANCE.md).
