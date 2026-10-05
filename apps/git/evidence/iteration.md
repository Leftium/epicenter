# Git testbed iteration evidence

## Baseline

Task began on 2026-10-05 in the app-schema-derive-export-import checkout.
The checkout was heavily dirty. Unstaged and staged binary patches, status,
and app/folder/plugin source were captured under
`/tmp/git-testbed-baseline-20261005` before editing. No earlier snapshot is
claimed. App source was an untracked scaffold.

## Foundation wave

Files read for implementation and post-implementation review:

```text
apps/
|-- README.md
`-- git/
    |-- package.json
    |-- svelte.config.js
    |-- vite.config.ts
    |-- scripts/dev.ts
    |-- server/git-server.ts
    |-- server/git-server.test.ts
    |-- src/lib/workspace.svelte.ts
    |-- src/lib/workspace.test.ts
    |-- src/lib/shims/zlib.ts
    |-- src/routes/+page.svelte
    |-- src/routes/+layout.svelte
    |-- src/routes/+layout.ts
    `-- src-tauri/
        |-- Cargo.toml
        |-- build.rs
        |-- tauri.conf.json
        |-- capabilities/main.json
        `-- src/lib.rs
packages/folder/src/
|-- file-browser.ts
|-- files.ts
|-- folder.ts
|-- browser-adapter.ts
|-- git/http.ts
|-- git/browser-backend.ts
|-- git/history.ts
`-- tauri-adapter.ts
```

Computer use through native Safari and the bundled Git lab app established:

1. Browser A reopened its persisted OPFS folder and displayed README Markdown source.
2. `printf` created terminal.txt; the tree updated and selection showed raw text.
3. Editor replacement saved; `cat terminal.txt` returned the editor's text.
4. Terminal overwrite refreshed a clean selected editor.
5. A fresh native bundle initially failed because its registered root did not exist.
   Rust now creates the app-owned directory before registration. The rebuilt bundle
   opened native B and fetched README.md and notes/color.txt.
6. Native terminal creation and editor autosave shared desktop.txt. Explicit
   staging and commit produced a5741e8. A stopped backend made push fail without
   undoing that commit. Restarting the backend and retrying push succeeded.
7. Browser A fetched the native commit. Status moved from 0 behind to 1 behind;
   desktop.txt did not appear in its tree. Pull refused its uncommitted terminal.txt.
   Committing terminal.txt produced ecf81cc and status 1 ahead / 1 behind.
8. Hiding and showing the browser terminal retained output and a typed command.
9. A NUL-containing sample.bin stayed visible and showed the binary/size explanation.
   Removing the disposable binary updated the tree and missing-file explanation.

Review found and repaired two save ownership bugs: concurrent flush waiters could
start duplicate next writes, and explicit overwrite bypassed the active-write
promise, allowing a file-switch receipt mismatch. Selection reads now also check
the selection generation. The synchronous selection flag and unused reload method
were removed. Clean external deletion disables editing; dirty input remains held.

The terminal was moved into the editor pane. Unused copied dependencies were
removed. The launcher now starts a missing backend when Bun reports
ConnectionRefused. Each fresh temporary remote gets a session-specific URL;
reopening one marked root retains its identity. HTTP routes serve only that remote.

Regression checks: seven app tests, zero failures. Held OPFS writes cover
concurrent flush, switch during saving, outside-change preservation, explicit
repair/discard, and switch during replacement. Real Git clones/pushes over smart
HTTP test the seeded remote and its identity. Browser and desktop frontend builds,
app typecheck, debug bundle, and release bundle passed.

These are foundation results. Clean divergence, editable unfinished merges,
two-parent resolution, and interrupted merge reopening are not yet accepted.

## Merge design checkpoint

Independent GPT and Claude Opus reviews support one mergeIncoming operation with
explicit refuse/leave conflict policy, default refusal, and manual-history-only
leave. Git metadata and index stages own the unfinished merge; ordinary file saves
and explicit stage/commit resolve it. No app-held conflict session or finishMerge
operation is needed. Refuse preserves automatic apps' existing no-change contract.

Required counterexamples: journal recovery must publish an unfinished merge without
committing it; matching MERGE_HEAD must not block its own publication recovery;
metadata cleanup after successful commit must not cause a duplicate merge; a
resolution equal to the original local tree still needs two parents; staging
base-identical text must clear unmerged stages. Root kv.json key merge semantics
and exact-byte protections remain requirements.

Coordination with Queue automatic history saves, Coalesce pending automatic commits,
and Implement folder row write queue agrees on ownership: editor owns latest typed
input, folder owns generation-counted automatic requests, app requests synchronization,
and repository owns durable merge state. Their committed source is preserved.
