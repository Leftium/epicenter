# Definition publication verification

These records predate the rename to `epicenter.json` and the object-schema
file shape (ADR-0525, ADR-0526); the saved files keep the `{ fields }` shape
of their day.

The [2026-10-08 computer-use run](computer-use-20261008/README.md) completes real
OPFS and Honeycrisp browser/native note acceptance and records two verified
collapses. Todos remote bootstrap remains unresolved. The records below describe
the earlier checkpoint and its then-unavailable UI access.

Verified on 2026-10-07 in
`/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import`.
Runtime publication and regression checks pass. Adversarial commit review also
found a Todos browser remote-bootstrap regression that requires a separate
decision. Actual bundled Honeycrisp startup
and relaunch preserve the generated definition and settled history. OPFS and
Honeycrisp note creation/editing/reopening through computer use remain unverified.

## Source and preservation

Task-start HEAD: `37323cf783f01f66e62a54976d2019b0ee7cb1f3`.
The checkout already contained substantial staged, unstaged, and untracked work.
Before editing, HEAD, both diffs, and an archive of untracked files were captured
in `/tmp/definition-publication-baseline/`. Its `source/` reconstructs that dirty
baseline. `task.patch` and `task-files.txt` isolate this wave from that baseline.
Unrelated files remain byte-identical to the captured baseline. The existing
staged change was left staged. The later
[commit review](commit-review.md) records task-only commits and verification of
their contents in an isolated tree.

[Source fingerprints](source-sha256.txt) identify the first implementation used
for the bundled-app run, before the later hidden-keyword repairs.
[Review](review.md) records that checkpoint's ownership, findings, and repairs;
[commit review](commit-review.md) records the subsequent findings and verification.
The independent Claude review used the repository's
[consult-claude skill](../../../../.agents/skills/consult-claude/SKILL.md).

## Checks completed

[Verification record](verification.txt) lists exact Bun commands and raw log
locations. First implementation checkpoint results:

- Definition: 146 passing tests.
- Folder: 823 passing, 21 native opt-in skips; Svelte tests: 14 passing.
- Real Rust native owner through the Tauri bridge: 21 passing.
- Honeycrisp: 316 application tests and 16 DOM tests passing.
- Definition, folder, app, and Honeycrisp browser/native/script typechecks pass.
- OPFS evidence bundle, Honeycrisp desktop frontend, and debug `.app` build pass.

Coverage includes fresh publication, replacement of malformed/manual descriptions,
changed declarations without changing saved rows/settings, unchanged reopening
without an extra settled commit, disabled automatic history, unsupported export,
failed writes, and uncertain native replies. Export tests compare restored
validation behavior for hidden constraints and object schemas. Installed TypeBox
1.1.23 source establishes why descriptors, runtime guards, and the format registry
need explicit checks rather than ordinary JSON.stringify.

## Actual native app startup and relaunch

Built with `bun run --cwd apps/honeycrisp tauri build --debug --bundles app`.
The exact app was launched by path, never by its shared application ID:

```text
/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/apps/honeycrisp/src-tauri/target/debug/bundle/macos/Honeycrisp.app
```

Disposable root: `/tmp/honeycrisp-definition-bundle.X792yw`.
`open -n -a <exact-path> --env HONEYCRISP_ROOT=<root>` launched the bundled app.
Its process executable was `Honeycrisp.app/Contents/MacOS/honeycrisp` (first PID
14104, relaunch PID 24338). Inspection confirmed `definition.json`, default
`kv.json`, and Git history were saved. The definition exactly matches current
`exportSchema(honeycrispDefinition)` output. The app was terminated after history
settled, then launched again against the same disposable root.

[Before relaunch](native-before-reopen.json) and
[after relaunch](native-after-reopen.json) record saved hashes, clean Git status,
identical HEAD, and identical log. History contains `Add definition.json` followed
by `Add kv.json`; the unchanged relaunch adds no commit. A copy of the actual
saved [definition](native-definition.json) is retained here. No note was created
or edited through the UI. This proves actual app startup/publication persistence,
not the requested complete note journey.

An earlier `HONEYCRISP_ROOT=/tmp/honeycrisp-definition-acceptance.1SuxBP bun
 dev:honeycrisp` run compiled and launched `apps/honeycrisp/src-tauri/target/debug/
honeycrisp` (PID 81808). That root remained empty when inspected; it is not
acceptance evidence. The bundled run above uses the first integrated source; the
later export repairs leave Honeycrisp's generated definition bytes unchanged.

## Computer-use attempts and precise blocker

`cua.getState()` exposes `browsers: []`. Creating Chrome or in-app browser tabs
fails with `Browser unavailable: chrome` and `Browser unavailable: iab`.
Selecting Google Chrome fails with `cgWindowNotFound`. Selecting the exact newly
built Honeycrisp `.app` also fails with `Computer Use server error -10005:
cgWindowNotFound`. The dev executable path is rejected as an invalid app. No
other installed app sharing its application ID was exercised.

The OPFS page was served at `http://127.0.0.1:5181` from
`bun packages/folder/evidence/opfs/serve.ts`; Honeycrisp browser UI was served at
`http://localhost:5175` from `bun dev:honeycrisp:ui`. Neither browser page could be
controlled or observed. No screenshot or browser storage result is claimed.
Task-owned dev servers and app processes were stopped after inspection. Temporary
roots and raw logs remain available for inspection.

## Remaining acceptance

Run the [real-OPFS evidence page](../opfs/main.ts), including its reload button.
The usual opener keeps automatic history disabled; the new publication section
uses a separate disposable history-enabled folder and checks its settled log.
The reload check reads the saved definition before reacquiring, so regeneration
cannot masquerade as persistence.

Then create and edit a Honeycrisp note, reopen it, and inspect both saved Markdown
and definition bytes plus settled Git history. Exercise a disposable browser
origin and the exact native `.app` with a fresh HONEYCRISP_ROOT. UI observations
must accompany file/history inspection. These journeys require working
computer-use browser/native surfaces. ADR 0508 remains Proposed; the execution
spec remains In Progress until those journeys pass.
