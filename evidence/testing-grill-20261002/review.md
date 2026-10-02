# Cumulative review

Files read as cumulative test diffs, followed by verification against the per-file reports:

```text
|-- .agents/
|   `-- skills/
|       |-- agent-instructions/
|       |   `-- scripts/
|       |       `-- run-trigger-eval.test.ts
|       `-- consult-claude/
|           `-- scripts/
|               `-- consult-claude.test.ts
|-- apps/
|   |-- api/
|   |   |-- runtime-profile.test.ts
|   |   |-- ui/
|   |   |   `-- src/
|   |   |       `-- lib/
|   |   |           `-- dashboard/
|   |   |               `-- navigation.test.ts
|   |   `-- worker/
|   |       |-- billing/
|   |       |   |-- autumn-products.test.ts
|   |       |   |-- autumn.test.ts
|   |       |   `-- policies.test.ts
|   |       |-- session-callbacks.test.ts
|   |       `-- trusted-origins.test.ts
|   |-- epicenter/
|   |   `-- src/
|   |       |-- app-installation.test.ts
|   |       |-- capture-application.test.ts
|   |       |-- mail-authorization.test.ts
|   |       |-- server.test.ts
|   |       |-- sidecar-runtime.test.ts
|   |       `-- static-assets.test.ts
|   |-- honeycrisp/
|   |   |-- native-tests/
|   |   |   `-- close.test.ts
|   |   `-- src/
|   |       `-- lib/
|   |           |-- editor/
|   |           |   `-- rich-session.test.ts
|   |           |-- note-source.test.ts
|   |           |-- notes.folder.test.ts
|   |           `-- notes.test.ts
|   |-- local-books/
|   |   |-- src/
|   |   |   |-- books/
|   |   |   |   |-- query.test.ts
|   |   |   |   |-- recategorize.test.ts
|   |   |   |   `-- report.test.ts
|   |   |   `-- token-store.test.ts
|   |   `-- test/
|   |       |-- cli-e2e.test.ts
|   |       |-- env-example.test.ts
|   |       |-- mode.test.ts
|   |       |-- oauth.test.ts
|   |       |-- sync.test.ts
|   |       |-- token-manager.test.ts
|   |       `-- tokens.test.ts
|   |-- local-mail/
|   |   |-- src/
|   |   |   |-- accounts.test.ts
|   |   |   |-- gmail-client.test.ts
|   |   |   |-- message-fields.test.ts
|   |   |   |-- oauth.test.ts
|   |   |   |-- outbox.test.ts
|   |   |   |-- reconcile-now.test.ts
|   |   |   |-- reconcile.test.ts
|   |   |   |-- storage.test.ts
|   |   |   `-- token-manager.test.ts
|   |   `-- ui/
|   |       `-- src/
|   |           `-- lib/
|   |               `-- actions.test.ts
|   |-- matter/
|   |   `-- src/
|   |       `-- lib/
|   |           |-- editor/
|   |           |   `-- markdown-live-preview.test.ts
|   |           `-- view/
|   |               `-- projector-roundtrip.test.ts
|   |-- self-host/
|   |   `-- local-lifecycle.test.ts
|   |-- todos/
|   |   |-- server/
|   |   |   `-- git-server.test.ts
|   |   `-- src/
|   |       `-- lib/
|   |           `-- files.test.ts
|   |-- vocab/
|   |   `-- src/
|   |       `-- lib/
|   |           |-- boot-node.test.ts
|   |           |-- chat/
|   |           |   |-- messages.test.ts
|   |           |   `-- opening.test.ts
|   |           |-- data.test.ts
|   |           `-- import.test.ts
|   `-- whispering/
|       |-- native/
|       |   `-- host.test.ts
|       `-- src/
|           `-- lib/
|               |-- formats.test.ts
|               |-- library.test.ts
|               |-- transformations.test.ts
|               `-- workspace/
|                   `-- desktop.test.ts
|-- packages/
|   |-- agent/
|   |   `-- src/
|   |       `-- loop.test.ts
|   |-- app/
|   |   |-- evidence/
|   |   |   `-- data/
|   |   |       |-- deletion-model.test.ts
|   |   |       |-- independent-document-roots.test.ts
|   |   |       |-- row-snapshots.test.ts
|   |   |       `-- what-the-crdt-buys.test.ts
|   |   `-- src/
|   |       |-- clipboard.browser.test.ts
|   |       |-- clipboard.test.ts
|   |       |-- data/
|   |       |   |-- artifact/
|   |       |   |   |-- checkout.test.ts
|   |       |   |   |-- frontmatter.test.ts
|   |       |   |   |-- import.test.ts
|   |       |   |   `-- render.test.ts
|   |       |   |-- definition/
|   |       |   |   `-- compile.test.ts
|   |       |   |-- store/
|   |       |   |   |-- current-open.test.ts
|   |       |   |   |-- flush-on-hide.test.ts
|   |       |   |   |-- persistence.test.ts
|   |       |   |   |-- store.test.ts
|   |       |   |   `-- sync.test.ts
|   |       |   `-- sync/
|   |       |       |-- attach.test.ts
|   |       |       |-- connection.test.ts
|   |       |       `-- transport.test.ts
|   |       |-- independent-blobs.test.ts
|   |       |-- index.test.ts
|   |       |-- product-startup.test.ts
|   |       |-- recording/
|   |       |   `-- browser.test.ts
|   |       |-- recording.test.ts
|   |       |-- store-blobs.test.ts
|   |       `-- sync-subprotocol.test.ts
|   |-- auth/
|   |   `-- src/
|   |       |-- persisted-auth-format.test.ts
|   |       |-- read-api-session.test.ts
|   |       `-- session-handoff-client.test.ts
|   |-- blobs/
|   |   `-- src/
|   |       |-- browser-lifecycle.test.ts
|   |       `-- bun.test.ts
|   |-- capture/
|   |   `-- src/
|   |       |-- compose.test.ts
|   |       |-- document.test.ts
|   |       `-- legacy/
|   |           `-- legacy.test.ts
|   |-- client/
|   |   `-- src/
|   |       `-- hosted-blobs.test.ts
|   |-- definition/
|   |   `-- src/
|   |       `-- addresses.test.ts
|   |-- folder/
|   |   `-- src/
|   |       |-- browser.test.ts
|   |       |-- kv.test.ts
|   |       |-- observers.test.ts
|   |       `-- tauri.test.ts
|   |-- matter-core/
|   |   `-- src/
|   |       |-- core/
|   |       |   |-- conformance.test.ts
|   |       |   |-- contract.test.ts
|   |       |   |-- parse.test.ts
|   |       |   |-- query.test.ts
|   |       |   |-- serialize.test.ts
|   |       |   |-- sqlite.test.ts
|   |       |   `-- table.test.ts
|   |       |-- field/
|   |       |   `-- field.test.ts
|   |       `-- load/
|   |           `-- fs.test.ts
|   |-- server/
|   |   |-- evidence/
|   |   |   `-- scope-ownership/
|   |   |       `-- foundation.test.ts
|   |   `-- src/
|   |       |-- auth/
|   |       |   |-- base-config.test.ts
|   |       |   |-- create-auth.test.ts
|   |       |   |-- instance-token.test.ts
|   |       |   `-- parse-bearer.test.ts
|   |       |-- local-blob-store.test.ts
|   |       |-- middleware/
|   |       |   `-- require-auth.test.ts
|   |       |-- principal.test.ts
|   |       |-- routes/
|   |       |   |-- authority-blobs.test.ts
|   |       |   |-- personal-blob-url.test.ts
|   |       |   |-- session.test.ts
|   |       |   `-- transcription.test.ts
|   |       `-- store-sync/
|   |           `-- browser-dial.test.ts
|   |-- skills/
|   |   `-- src/
|   |       `-- skills.test.ts
|   |-- sqlite/
|   |   `-- src/
|   |       `-- adapters.test.ts
|   `-- svelte/
|       `-- src/
|           |-- from-data.svelte.test.ts
|           |-- from-subscription.svelte.test.ts
|           `-- persisted-map.svelte.test.ts
`-- scripts/
    |-- check-api-paths.test.ts
    |-- check-doc-hygiene.test.ts
    `-- check-vocabulary.test.ts
```

Findings resolved before acceptance:

- A helper import had landed inside a one-line clipboard JSDoc. The actual import was restored and both tests and typecheck reran.
- Native transcription returns an ordinary uncorrelated response object. Its precise `error: null` assertion was retained instead of treating it as a wellcrafted Result.
- Capture's app package has no direct wellcrafted dependency. Its existing discrimination remained instead of adding a dependency for assertion cleanup.
- A snapshot acceptance control bypassed hub authorization. It now enters through the hub and first proves that the snapshot position can advance.
- A stale-close callback was optional. The test now requires the captured callback before replacing the connection.
- A gated partial-output scenario needed failure cleanup. It now releases the gate and disposes the conversation in `finally`; its 28-test suite passed afterward.

Ownership and scope:

The tests observe the boundary that owns each promise: compilation validates codec declarations; the hub authorizes snapshot offers; a recorder owns capture cleanup; subscription adapters detach listeners; persistence releases successfully written keys. Test fixtures no longer stand in for those owners when doing so makes the assertion vacuous. The pass added no production helpers, exports, compatibility layers, or package boundaries.

The removed SQLite rollback and Response finalizer scenarios implemented their own behavior inside the test. Production publication/reopening and real route consumption/cancellation coverage remain. Duplicate artifact, parser, and declaration assertions were removed only after identifying stronger retained cases. Exploratory evidence and runtime boundary tests with different execution paths remain.

Final checks:

All 342 inventory paths occur in the review reports, all 342 begin with JSDoc, and all 127 changed paths are tests. Full configured tests and typechecks pass. The native baseline limitations are recorded in the front-door report. No production probe diff remains.
