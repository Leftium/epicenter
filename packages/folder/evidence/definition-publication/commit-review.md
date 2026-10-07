# Publication commit review

Reviewed on 2026-10-07. This follows the earlier implementation review; it is
not a claim that the computer-use journeys passed.

## Files read

The earlier [review](review.md) lists the cumulative implementation surface.
The commit review additionally inspected these sources and task-only diffs:

```text
|-- .agents/skills/
|   |-- adversarial-review/SKILL.md
|   |-- collapse-pass/SKILL.md
|   |-- consult-claude/SKILL.md
|   |-- post-implementation-review/SKILL.md
|   `-- rethink/SKILL.md
|-- apps/todos/src/lib/
|   |-- platform/folder.browser.ts
|   `-- todos.svelte.ts
|-- packages/definition/
|   |-- README.md
|   `-- src/
|       |-- declaration.ts
|       |-- export.ts
|       |-- export.test.ts
|       |-- index.ts
|       `-- prepare.ts
|-- packages/folder/
|   |-- README.md
|   `-- src/
|       |-- browser-adapter.ts
|       |-- browser-git-transport.test.ts
|       |-- browser-storage.test-support.ts
|       |-- bun.ts
|       |-- definition-publication.test.ts
|       |-- git-http.test-support.ts
|       |-- git/history.ts
|       |-- publish-definition.ts
|       |-- publish-definition.test.ts
|       |-- publication-log.test-support.ts
|       |-- tauri-adapter.ts
|       `-- tauri-native.test.ts
`-- typebox/build/schema/
    |-- engine/_stack.mjs
    |-- engine/ref.mjs
    |-- engine/schema.mjs
    |-- resolve/ref.mjs
    |-- resolve/ref.d.mts
    |-- schema.mjs
    `-- types/ (schema-bearing keyword guards)
```

## Independent findings and adjudication

Fresh GPT and Claude Opus reviews started from the actual outcome and callers.
Both retained definition ownership of portable export, one shared publication
operation, and explicit acquisition-side calls. Neither found a worthwhile
replacement using raw stringify, export caching, or another history policy.
Raw Claude results are retained at
`/tmp/definition-publication-commit-review/claude-initial.json`, session
`ed4b4509-88c4-4580-80e4-969b34e43413`.

Both found a fidelity bug missed by the earlier reviews: TypeBox enumerates
members of `properties`, `patternProperties`, `dependencies`, `dependentSchemas`,
and `dependentRequired`. Making a hidden member enumerable can strengthen
validation. The exporter now refuses those hidden members. It visits actual
schema positions and follows reference targets using public `Resolve.Ref` and
native ID/recursive-anchor scopes. This preserves legal field names, hidden
`minLength`, hidden `$defs`, and hidden literal members. Blanket refusal of all
hidden keywords would discard portable constraints that can be preserved.

The GPT reviewer then implemented the map and cache-sharing repairs. Its earlier verdict was
independent; its implementation and verification are not a second independent
review. Codex inspected the source and checked the isolated commit tree. Claude
was consulted again about the concrete repairs in the same read-only session.
Its final review found no remaining source blocker for TypeBox 1.1.23 under
the same evaluation mode. Raw follow-ups are `claude-repair.json` and
`claude-partition.json` in the review directory; both completed without errors
or permission denials. This used the repository’s
[consult-claude skill](../../../../.agents/skills/consult-claude/SKILL.md).

Claude’s follow-up found another reproduced failure: TypeBox hashes compiled
functions using only enumerable top-level schema keys. A hidden keyword can
make different reference targets share one validator before export. Marker-only
differences can also split that sharing after export when lookup depends on
the surrounding scope. Conversely, JSON normalization of negative zero can
merge previously distinct cache entries. The repair compares original and
materialized hashes at field roots and reference targets, refusing changes
to cache-sharing groups in either direction. It uses TypeBox’s public hashing
and resolution APIs and tracks cumulative URL plus nearest ID and recursive
anchor. It preserves hidden constraints when sharing remains unchanged.

The descriptor copier remains necessary to refuse runtime constraints and
non-JSON annotations without invoking callbacks. The reference-aware scan owns
a different fidelity rule and does not implement validation. This additional
complexity is tied to installed TypeBox 1.1.23; an upgrade needs a review of its
schema positions, function hashing, and reference semantics. Returned and thrown write failures
retain their existing small diagnostic branches rather than translating
Results into exceptions or adding a reporting-only abstraction. Publication
now emits private typed diagnostics with a destination and original cause;
tests capture memorySink without adding a production logging option. Claude
flagged a shared-process test-order risk; it reproduced, and one shared test
fixture replaced the duplicate capture setup. Explicit forward and reverse
module-import runs each pass all ten publication tests.

## Consequential integration finding

An executable before/after check used real system Git smart HTTP with separate
in-memory browser folders. Before this feature, a fresh manual or automatic
folder fast-forwarded an existing remote. Now manual history returns
`Dirty` for `definition.json`; automatic history returns `Diverged`, followed
by `UnsupportedHistory` from default merge. The remote KV remains absent.
A regression records both outcomes. No Git protection was relaxed.

Todos currently opens before its first pull. No public browser clone/bootstrap
operation exists. A separate read-only caller investigation found that existing
internal backend/history primitives could bootstrap before assembly, but a new
public initialization boundary is needed. Mandatory first-download startup
would change Todos' documented offline behavior. This requires a separate
product decision; the publication feature does not silently make that choice.
Raw experiments:
`/tmp/definition-publication-commit-review/fresh-remote-before.txt` and
`fresh-remote-current.txt`.

## Commit isolation and verification

Task-start HEAD was `37323cf783f01f66e62a54976d2019b0ee7cb1f3`, with substantial
unrelated dirty work. Three-way task-only merges remove those unrelated hunks
from the proposed commits while leaving live files unchanged. Dedicated Git
indexes keep the pre-existing staged device change outside every commit.
One required prerequisite, `c0caabc5db`, imports the existing history-refusal
assertion. The missing import reproduced at task-start HEAD and its focused
12-test suite passes after the one-line fix.

The isolated tree was installed using frozen Bun locks, including the separately
locked edit-handle evidence package. Proposed commit contents pass:

- Definition: 163 tests and typecheck.
- Folder: 825 tests, 21 opt-in skips, 14 Svelte tests, and typecheck.
- Real Tauri/Rust bridge: 21 tests using the already-built current native owner.
- Honeycrisp: 316 application tests, 16 DOM tests, and browser/native/script typechecks.
- OPFS evidence build and Honeycrisp desktop frontend build.

The app package typecheck fails identically at task-start HEAD and in the isolated
feature tree, on nine existing test diagnostics in artifact import and store
persistence. The dirty checkout's independent fixes remain uncommitted by this
feature. It is inaccurate to claim the isolated app package passes. Its live
checkout typecheck passed during the earlier implementation verification.

A preservation audit compared 4,916 unrelated baseline files: zero differences.
The original staged binary diff remains identical. A concurrent API commit,
`0979353641`, then changed six unrelated files; its changes are preserved in the
commit parent and isolated tree. Feature indexes are refreshed against that HEAD
rather than reverting it. Raw logs, temporary trees,
review output, and task-only patches live in
`/tmp/definition-publication-commit-review/`.

## Acceptance limits

The original native startup/relaunch evidence used the first integrated
implementation before the hidden-map repair. Honeycrisp's published definition
has no such hidden maps; its output is unchanged. Source fingerprints from that
run remain historical evidence. The real native bridge was retested with the
repaired source and isolated commit contents.

Computer-use was retried: inventory still exposes no browsers, and selecting
`/Applications/Google Chrome.app` returns `cgWindowNotFound`. No OPFS reload or
Honeycrisp browser/native note journey is claimed. The spec remains In Progress
and ADR 0508 remains Proposed while UI acceptance and the bootstrap finding
remain unresolved.

## Local commit waves

- `c0caabc5db`: prerequisite history assertion import, 12 focused tests pass.
- `50e0fae857`: prepared portable export and fidelity regressions.
- `3ddf635416`: all three publication paths, typed diagnostics, and dependent regressions.
- This evidence wave records the OPFS page, Proposed ADR, In Progress spec, and acceptance limits.

The descriptor and cache checks preserve same-mode TypeBox behavior. They do not
reconcile existing compiled/interpreted disagreements or convert every field
into standards JSON Schema. Claude considered generated-code comparison; it
misses interpreted map visibility and trades about forty lines for thirty-five
lines coupled to generated code text. That supplies no worthwhile deletion
prize. The existing ownership and fidelity checks remain. No commit was pushed.
