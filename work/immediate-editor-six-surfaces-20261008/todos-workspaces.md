# Todos workspace migration acceptance

Source baseline: `6b5758159f486651b6aa55a9a7efde4dccf89efc`. ADR 0507 remains Proposed; documentation commit 6b5758159f records the agreed destination, not implementation completion.

## Outcome

Files tree opens complete text. Todos list opens structured controls for valid rows. Remove per-record interpretation tabs. Preserve accepted failed input and one active app publisher per file during explicit workspace handoff. Do not silently replace invalid structured controls with Source.

## Browser baseline, 2026-10-08

Actual Chrome Guest UI, disposable fresh origin http://localhost:25862/. UI started with repo-root dev:todos:ui. Full dev:todos server also provides loopback Git on 5187; its UI is 5186. Logs /tmp/todos-workspaces-baseline-dev.log and /tmp/todos-workspaces-ui.log. Sessions 42877 and 25066.

1. Created Workspace doctrine acceptance, todos/8a533a44-007e-43be-9b38-9dcecf1a62a1.md. File-tree click kept structured controls with Source tab, demonstrating the coupling being removed.
2. Source tab saved malformed YAML (title: [unfinished). The todo list kept a Needs repair row with disabled checkbox; Source was the only enabled interpretation. This file remains for integrated repair acceptance.
3. Created Structured workspace acceptance, todos/652be65d-6f41-4e6b-a452-ac2154134095.md. Notes entered through the real UI: Keep this body across workspace switches. Status showed Saved.

These observations demonstrate browser OPFS behavior only, not native desktop or hardware acceptance. No provider/account required by Todos.

## Implementation assignment

Dedicated independent clone /tmp/todos-workspaces-20261008, baseline as above, frozen dependencies installed. Claude delegate launch session shell 47370; native result pending in /tmp/todos-workspaces-worker.json. Allowed paths apps/todos only, no commits or child agents. Coordinator owns review, integration, UI acceptance and serialized explicit staging. Assignment covers separate acquisition, stable identity key, malformed discoverability/repair, safe handoff, same-file checkbox and old callback regression, failed-save retention.

## Protection and pending verification

Pre-existing staged packages/device/src/owner.ts preserved; snapshot /tmp/workspace-migration-device-before.patch. Other checkout changes are unrelated and must remain untouched. Baseline mounted checks running, log /tmp/todos-workspaces-baseline-mounted.log. Next: inspect worker actual diff, reproduce tests/typechecks/builds, integrate and re-exercise Files/Todos/repair/navigation in real UI. Do not count worker reports as coordinator acceptance.

## Coordinator baseline checks

Before app integration: owner tests 98 pass / 0 fail (814 assertions), mounted tests 15 pass / 0 fail (143 assertions), typecheck browser and host Svelte leaves 0 errors / 0 warnings and scripts tsc successful, browser and host builds successful. Logs /tmp/todos-workspaces-baseline-{owner,mounted,typecheck,build,host-build}.log. Browser reload and explicit todo reopen showed the saved note text intact.

Worker session identified in task-owned log as 51dbff9a-b9e4-4d34-8bca-e10792dc1d65; final native result still pending. Partial diffs are inspection only, not acceptance or integration.

## Preliminary review while worker runs (not final acceptance)

Files read for baseline and partial-flow inspection:

```text
apps/todos/
|-- README.md
|-- package.json
`-- src/
    |-- lib/
    |   |-- editor.svelte.ts
    |   |-- todo-editor.svelte.ts
    |   `-- todos.svelte.ts
    `-- routes/components/
        |-- FileView.svelte
        |-- TodoDetail.svelte
        |-- TodoList.svelte
        `-- TodosView.svelte
```

Candidate for correction once the initial worker turn finishes: partial toggle implementation still refuses a displayed raw editor merely because its path is currently shown (IN_FILES). That would retain a view-based write gate under a new name. The requested replacement is safe explicit ownership transfer or another single-publisher operation that preserves raw accepted text; failure to settle remains a justified refusal. Review the final artifact before adjudicating, since this is an in-flight diff.

The keyed detail and discarded binding lifetime can stop outgoing visible controls without copying mode state into ordinary setters. New Detail/Handoff boundaries must earn their place through actual identity and recovery behavior, not fixture access alone. Final review pending.

Full Todos test command before any migration integration: 167 pass, 2 fail; command exits before mounted suite, which was run separately and passed. Failures: server/git-server.test.ts:81 expects commit subject Add todos/milk.md, receives Update 2 files; platform-selection.test.ts:93 host graph unexpectedly includes packages/folder/src/git/runner.ts. Log /tmp/todos-workspaces-baseline-full-test.log. These failures demonstrably precede this migration's app integration in the live dirty checkout; attribution to older work is not investigated. Keep them separate from migration regressions; do not modify shared packages or weaken assertions to make this wave green.

## First worker report and correction

First native result /tmp/todos-workspaces-worker.json: session 51dbff9a-b9e4-4d34-8bca-e10792dc1d65, is_error false, actual model claude-opus-5-5. Five Bash permission denials recorded; the worker used permitted file tools for edits and Node-local tooling for browser/host typechecks and browser build. No Bun tests ran in that sandbox; host build was denied. These are reports, not coordinator reproduction. No access escalation or denied-command retry requested.

Correction dispatched in same dedicated clone/session, output pending /tmp/todos-workspaces-worker-correction.json, shell session 72474. Accepted split/key/retention shape; rejected displayed-Files checkbox gate. Correction uses public patchRowText on the current raw buffer and the same publisher, keeps failed/unknown input protected, and replaces refusal tests with preservation tests. Also remove reload's unnecessary typing fence while retaining app path reservation; native InputChanged protects newer accepted typing. Stop after these two changes; coordinator owns all checks.

Final review inventory (review pending until the correction completes):

```text
apps/todos/
|-- README.md
`-- src/
    |-- lib/
    |   |-- departure.test.ts
    |   |-- editor.svelte.ts
    |   |-- incoming.test.ts
    |   |-- todo-editor.svelte.ts
    |   |-- todo-editor.test.ts
    |   |-- todos.svelte.ts
    |   `-- todos.test.ts
    `-- routes/components/
        |-- Detail.svelte
        |-- FileBrowser.svelte
        |-- FileNameBar.svelte (unchanged caller)
        |-- FileView.svelte
        |-- Handoff.svelte
        |-- Lifetime.svelte (unchanged caller)
        |-- SaveStatus.svelte (unchanged caller)
        |-- TodoDetail.mounted.test.ts
        |-- TodoDetail.svelte
        |-- TodoList.svelte
        |-- TodoStatus.svelte (unchanged caller)
        |-- TodosView.svelte
        |-- file-actions.ts (unchanged caller)
        `-- fixtures/TodoDetailHost.svelte
```

## Coordinator artifact validation and review

Correction result: same session, is_error false, zero permission denials, actual claude-opus-5-5. Coordinator ran the artifact in the clone with Bun. Initial failures were unrun fixture issues: a raw-file test used the Todos entrypoint; new repair assertions raced coalesced listing hints; FileView requires the Tooltip.Provider the real layout supplies. Fixed the raw entrypoint, joined listing work through check(), and supplied actual layout context in the fixture. Mounted checkbox assertion now waits for its rendered listing state as well as native save state.

After fixes: 139 owner/recovery/departure tests pass, 17 mounted tests pass. The seventeenth is a coordinator-added counterexample: an old Files discard button cannot discard a newer accepted todo at the same path. It passed without a new production guard, so no extra status flag was added. Browser/host/scripts typechecks passed before these fixture-only corrections and will be rerun integrated.

Review verdict: Detail owns the keyed rendering/identity boundary used by wide and narrow layouts; Handoff owns the shared recovery surface for both directions and retains no mirrored content or operation state. toggleText names the source-preserving operation through the already-active raw publisher. Keep these boundaries. Keep path reservation/admitting/recovery/departure/close accounting and the existing retention cache. No generic table selection or editor framework introduced. Removed mode methods, rawMode state, validity-as-view switching, mode-gated setters and reload typing fence. Straggler search found no old rawMode/editSource/editFields/selectedPath/selection/OpenFile/needsRepair/IN_FILES/IN_SOURCE references under apps/todos.

Small review cleanup before integration: new Repair and Current type names and NOT_A_TODO constant have no importing consumers. Keep their local names but remove their exports. Workspace and Retained are imported by the actual view consumers and remain exported. The toggleText non-error saving case returns no failure, not a saved receipt; the live SaveStatus remains authoritative, so do not add a new completion/refusal state.

## Integrated review correction

A targeted coordinator regression reproduced a real latest-navigation race: Files -> Todos handoff held at settle, then Files requested again, installed a todo owner under the Files selection. The new request returned early on the path reservation. Fixed open() to await the existing reservation and recheck the current navigation before admission. No new state or generic coordinator. Regression failed before the fix; rerun pending.

Export cleanup correction: NOT_A_TODO had a test-only dynamic-import consumer. The production constant stays local; the test now checks the user-visible repair instruction instead of importing an internal constant. Integrated typecheck passes.

Browser environment: Chrome became shared with a concurrent fixture UI task; native indices were no longer reliable. Moved acceptance to a dedicated Safari tab at localhost:25863. The old Chrome origin 25862 now refuses startup because its folder lacks a ready marker; it was left untouched. Fresh origin startup succeeds. That is a separate folder-format compatibility blocker, not resolved by this app migration. Typecheck/build generated files can refresh the dev page, so final acceptance runs after checks stop.

The first race correction waited for all reserved operations; full owner tests exposed a rename-contract timeout. Replaced it with the narrower fix: after handoff drains, admit() acquires the latest shown workspace for that path. Ordinary reservation admission stays unchanged. Final owner/recovery/departure tests: 140 pass, 0 fail; /tmp/todos-workspaces-integrated-owner-final.log. Final source re-read moved the loading-claim comment with the loading claim. No additional state introduced.

## Final integrated acceptance

Final verification against the live checkout:

- Owner/recovery/departure tests: 140 pass, 0 fail, 1,171 assertions. Log: /tmp/todos-workspaces-integrated-owner-final.log.
- Mounted UI tests: 17 pass, 0 fail, 163 assertions. Log: /tmp/todos-workspaces-final-mounted.log.
- Browser and host Svelte typechecks: zero errors and warnings; scripts TypeScript check passes. Log: /tmp/todos-workspaces-final-typecheck.log.
- Browser and host builds pass. Logs: /tmp/todos-workspaces-final-build.log and /tmp/todos-workspaces-final-host-build.log.
- Full Todos test command: 170 pass, two failures, matching the two failures reproduced before integration above. Log: /tmp/todos-workspaces-final-full-test.log. The command stops before mounted tests, which passed separately.
- Scoped diff whitespace check passes. Unrelated generated-file whitespace in the dirty checkout was left alone.

Computer-use acceptance used native Safari controls at http://localhost:25863/ after final checks stopped refreshing the development page. Disposable browser-local data only; no provider push. Created todos/794407f3-9c67-4f9c-b499-0687a955a5dd.md and a second todo, todos/faa8ae7e-1de0-43e1-b790-67a844b0db7d.md.

Verified these actual UI journeys:

1. Create a todo and enter Notes. Select its file-tree entry: complete Markdown appears in Files without structured fields or Source/Fields tabs.
2. Add owner: keep-me and a second body line in Files. Click its todo-list checkbox: the same raw publisher saves done: true and preserves the extra field and body.
3. Save malformed YAML title: [unfinished. The editable list excludes it; a named repair entry exposes the parse reason and opens the exact saved source in Files.
4. Repair title in Files. The repair entry disappears and the todo returns to the list; the mounted Files view stays raw.
5. Select the todo-list entry: structured Done, Title and Notes controls appear. Edit title to Structured round trip, then Open in Files: complete saved Markdown retains owner: keep-me, done: true and both body lines.
6. Create Second isolated todo. Its Done is false and Notes are empty. Return to Structured round trip: Done is true and its original Notes remain. No fields leak across selection.
7. Reload Safari. The folder reopens with both todos. Open the first file-tree entry: the persisted title, extra owner field, Done and both body lines remain intact.

Fresh Safari folder creation and reopening pass. The older Chrome-origin ready-marker failure remains a separate unresolved folder-format compatibility blocker; its contents were preserved. Native desktop interaction and provider acceptance were not exercised. Host compilation is build evidence only. Failure/recovery interaction is covered by mounted tests, not claimed as injected failure in the Safari journey.

This wave implements Todos only. ADR 0507 remains Proposed; Honeycrisp and Capture remain separate migrations. Next use the same bounded workflow on one of them: capture baseline behavior, change the selection/editing ownership, test counterexamples, then re-exercise the integrated app. Do not expand this commit into shared folder changes or further cleanup waves.
