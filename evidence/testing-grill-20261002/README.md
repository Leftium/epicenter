# Testing grill, 2026-10-02

Completed one full-file testing pass over all 342 `.test.ts` files, including five hidden skill-script tests. The [inventory](inventory.txt) enumerates every file. Three supervised reviewers covered 81, 121, and 115 files; the integrating reviewer covered 25. Every inventory path has a recorded verdict. No test file was removed.

Changed 127 test files. The pass repaired unreachable scenarios, awaited asynchronous failures, replaced permissive Result helpers, strengthened independent outcomes, cleaned resources, corrected contract documentation, and removed duplicate or fixture-only assertions. All 342 files now begin with their contract JSDoc. Production code and dependencies were unchanged.

Per-file evidence:

- [App data and synchronization: 81 files](app-data.md)
- [Folder, server, auth, and supporting tooling: 121 files](folder-server-auth.md)
- [Applications and runtime capabilities: 115 files](applications.md)
- [Shared packages and documentation gates: 25 files](shared-packages.md)

The reports distinguish proposed cuts from accepted changes. Retaining a scenario is a completed verdict. Real filesystem, browser, SQLite/WASM, workerd, Git, protocol, and lifecycle boundaries were retained where overlap earns regression confidence. Source verification concentrated on deciding claims; a full-file test read does not imply that every production dependency was read in full.

Validation:

- `bun run test`: 157 script/skill tests and 3,284 workspace tests passed; zero failures. Default native-folder opt-in skips: 15.
- `bun run typecheck`: passed across the repository.
- Real folder native bridge: all 15 opt-in tests passed separately.
- Server Workers: 32 tests passed. Enrollment admission workerd evidence: 18 passed. Folder bundle/import-closure evidence: seven passed.
- Changed-file Biome formatting and lint completed with zero errors. Lint reported 303 warnings and 11 informational diagnostics. No unsafe lint fixes were applied.
- `git diff --check`: passed.
- Four deliberate defect probes exposed missing subscription detach, a permanently held persisted key, stale socket closure, and stale fragment retention. All production probe edits were restored; the socket/fragment probes ran in scratch copies.

The task-start workspace run had three failures: a stale startup fixture, a malformed-codec test calling an inert declaration instead of compilation, and a media-progress assertion after a fixed delay. Each fixture or assertion was corrected against the current owner without weakening its promised outcome.

Two additional validation commands remain blocked by unchanged baseline issues. The Honeycrisp native package command fails three Rust cases using the obsolete `write` mutation variant, before reaching its JavaScript stage; the separately built close harness passes all 25 JavaScript cases. The production enrollment test config fails before tests on the `pg-protocol` module import. Native TypeScript fixture tests do not verify live microphone hardware.

Work started from `braden-w/app-schema-derive-export-import` at `f6bf10839188c595a8258f835066c985ce70a70d` on branch `braden-w/testing-grill-all-tests`. Concurrent documentation work and existing dirty/untracked files were preserved. Only audited tests and this evidence directory were staged for the testing commits. The testing branch is retained after the merge.

See [the cumulative review](review.md) and [changed paths](changed-tests.txt). Raw local command logs remain in `/tmp/epicenter-testing-grill/`.
