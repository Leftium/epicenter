# Final implementation review

Files read (the acceptance entrypoints and their ownership chain):

```text
Zhongwen/
|-- README.md
|-- scripts/
|   |-- local-sync.ts
|   |-- local-sync-relay.ts
|   |-- local-sync-relay.test.ts
|   |-- release.mjs
|   `-- probes/sync/{local,unreachable}.test.svelte.js
`-- src/
    |-- hooks.client.ts
    |-- lib/
    |   |-- {definition,folder,api,practice}.ts
    |   |-- sync{,-relay,-session,-writes}.ts
    |   |-- sync.test.ts
    |   `-- components/{SyncPanel,Practice,EntryCard}.svelte
    `-- routes/{+page,+layout}.svelte
Epicenter/
|-- apps/epicenter/
|   |-- README.md
|   |-- src/{main,sidecar-runtime,server}.ts
|   `-- src-tauri/
|       |-- src/{lib,installed_apps,runtime_evidence}.rs
|       `-- capabilities/installed-app-folder-{production,development}.json
`-- packages/
    |-- folder/
    |   |-- README.md
    |   `-- src/
    |       |-- {contract,browser-adapter,tauri-adapter}.ts
    |       |-- git/{http,browser-backend,history,merge,errors}.ts
    |       |-- native/bindings.gen.ts
    |       `-- {tauri,browser-git-transport,merge-unrelated}.test.ts
    `-- tauri-plugin-epicenter-folder/
        |-- README.md
        |-- src/{commands,tests}.rs
        `-- core/src/{owner,history,merge,merge_tests}.rs
```

The transport boundaries earn their separate modules: browser session capture
owns the fragment and tab lifetime; the launcher owns GH credentials and the
fixed upstream; Folder owns Git mutation and conflict refusal; the app controller
owns the user-visible sync lifecycle. The native shell owns installed membership,
window identity, folder registration, and generation admission. There is no
parallel application-controlled native root or origin.

Grounded review findings were fixed before handoff:

- Navigation to Sync could discard failed note drafts or unsubmitted additions.
  It now retains the Words page and input, with a reason. The navigation guard
  tolerates destinations without route information; mounted repair checks pass.
- Conversation turn writes now join the same pending-write tracker as API writes.
- Sync state now lives with the page's folder, so route changes cannot start a
  second controller or discard its result.
- A successful push followed by another automatic local commit cannot report all
  local work synchronized merely because the worktree is clean. The controller
  compares heads and displays later changes. A real Git regression test covers it.
- A status failure after transfer reports an unconfirmed current state rather than
  treating unreadable status as clean. Received paths accumulate across retries.
- The relay refuses unexpected upstream content types. A regression test covers
  refusal without forwarding authentication or upstream headers.
- Bootstrap failure text no longer promises untouched state for a partial update.
- Desktop merge options reach the Rust owner; they are not silently dropped.
  Optional RPC flags preserve older requests. Bindings were generated and tested.

Conflict resolution is explicit and repairable: both original versions are already
committed, compare-and-swap protects changed files, and refusal keeps the files
unchanged. Clean merge, real conflict refusal, explicit resolution, offline saves,
tutor persistence, browser download, and native push/pull all passed acceptance.

Limits and reproduction commands are recorded in checkpoint.md. No speculative
UI redesign or additional hosted authentication was added during review.
