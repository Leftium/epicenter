# Cumulative implementation review

This records the first implementation checkpoint. The subsequent
[commit review](commit-review.md) found and repaired additional hidden-keyword
fidelity failures and reproduced a Todos remote-bootstrap regression. Its
findings supersede the earlier no-blocker conclusions below.

## Files read

Runtime sources and task-relative test/documentation diffs are listed below. The
review baseline is the reconstructed task-start checkout, including its dirty
and untracked files, rather than HEAD alone.

```text
|-- apps
|   `-- honeycrisp
|       |-- README.md
|       |-- package.json
|       `-- src
|           `-- lib
|               |-- notes.folder.test.ts
|               `-- platform
|                   `-- first-open.test.ts
|-- docs
|   `-- adr
|       `-- 0508-folder-opening-overwrites-root-definition-json.md
|-- packages
|   |-- definition
|   |   |-- README.md
|   |   |-- package.json
|   |   `-- src
|   |       |-- export.test.ts
|   |       |-- export.ts
|   |       |-- index.ts
|   |       `-- prepare.ts
|   `-- folder
|       |-- README.md
|       |-- evidence
|       |   `-- opfs
|       |       `-- main.ts
|       `-- src
|           |-- browser-adapter.ts
|           |-- browser-git-transport.test.ts
|           |-- browser-opfs.test.ts
|           |-- browser-scope.test.ts
|           |-- browser.test.ts
|           |-- bun.ts
|           |-- close.test.ts
|           |-- definition-publication.test.ts
|           |-- definition.test.ts
|           |-- entries.test.ts
|           |-- files.test.ts
|           |-- files.ts
|           |-- folder.ts
|           |-- git
|           |   |-- history-attempt.test.ts
|           |   |-- history.ts
|           |   `-- opfs-incoming.test.ts
|           |-- incoming-attributes.test.ts
|           |-- index-reconcile.test.ts
|           |-- native-capture.test.ts
|           |-- native-publication.test.ts
|           |-- native-safety.test.ts
|           |-- native.test.ts
|           |-- observers.test.ts
|           |-- publish-definition.test.ts
|           |-- publish-definition.ts
|           |-- source-scope.test.ts
|           |-- storage.ts
|           |-- tauri-adapter.ts
|           |-- tauri-native.test.ts
|           `-- tauri.test.ts
`-- specs
    `-- 20261007T104838-definition-publication.md
```

Installed TypeBox 1.1.23 sources also read: `build/system/memory/clone.mjs`,
`build/schema/engine/_guard.mjs`, `build/format/format.mjs` and
`build/format/_registry.mjs`; the independent reviewers also traced compiler,
refinement, constant, enum, and reference behavior.

## Findings and repairs

Independent GPT review ran before adapter implementation and checked the prepared
identity and format-handler gates. Claude Opus reviewed export ownership and
fidelity in read-only session `7384de99-f373-43f5-9700-f364cbe160ec` through
consult-claude. Its followup finished successfully with no permission denials.

Repairs: require prepared result identity before property reads; reject custom,
missing, or replaced stock format handlers; preserve declared object order rather
than sorting; retain preparation-time callback knowledge if an author removes a
guard. The last repair has a regression test. GPT's final narrow check confirmed
all seven export tests and additionally exercised deleted nested KV/table guards.
Both independent reviewers found no remaining concrete fidelity blocker.

Cumulative review found no further runtime blocker. The remaining verification
blocker is actual UI acceptance, documented in README.md. Tests were compared
against a passing 220-test task-start subset and passing definition/folder
baseline typechecks. The final integrated suites pass, including real native
owner tests. No failing check is dismissed as pre-existing.

## Ownership and collapse

The rethink ownership check keeps prepared identity and compiled callback
knowledge in definition preparation. Export owns portable fidelity and refuses
the whole document if it cannot preserve it. The descriptor walk remains needed:
cached callback flags alone cannot catch non-JSON annotations, hidden keywords,
or a subsequently modified format registry. No export cache is introduced.

`publishDefinition` owns one shared best-effort discovery operation for three
adapters. Inlining it would duplicate failure and uncertain-outcome policy.
Assembly remains synchronous and owns the folder lifetime. Each opener awaits
publication only after it has assembled the usable handle.

`files.overwrite` owns the create-or-replace save. Browser/Bun accounting requests
existing automatic history; Tauri delegates it to the native owner. Publication
adds no commit, push, comparison read, checkpoint wait, history policy, importer,
or migration. Identical settled trees create no commit. Application declarations
stay authoritative; manual descriptions can be replaced.

Test changes retain their original failure, capture, close, and recovery purposes.
They include the new root file and settle publication before later-operation
assertions. Clone fixtures clone before opening where appropriate; raw initial
pull fixtures explicitly remove the generated untracked file before seeding the
remote tree. This is an opening consequence, not relaxed incoming protection.

## Intentionally retained limits

The format describes standalone TypeBox 1.x fields, not one root JSON Schema.
Guard keys and unsupported format strings inside annotation data are also refused
conservatively. A dialect marker, generic editor, schema import, and migrations
are outside this wave. No memoized export or new asynchronous assembly API earns
its additional state or lifecycle contract.
