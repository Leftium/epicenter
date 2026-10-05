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

### Foundation acceptance and commit

Foundation committed as `a42574064d`, using a temporary index to exclude unrelated root dependencies and preserve the already staged device change. App tests passed seven cases with forty assertions; typecheck reported zero errors and warnings. Browser and desktop UI builds passed, as did debug and release Tauri bundle builds.

Computer use opened the release bundle, acquired local-only B, created and staged a file, committed it, edited its raw text, and reopened the copy with the saved text intact. The terminal remains below the editor. macOS typing substituted smart quotes in the first shell command; literal paste worked and the initial failed command stayed visible. The command field now disables correction and capitalization. Local-only status now says Local history rather than describing an absent remote.

The root `bun dev:git:desktop` built and ran the development binary. Computer use cannot select a bare macOS executable. A task-owned copy of the bundle metadata with that exact newly built executable made it selectable, serving the development frontend at 127.0.0.1:1431. The development copy reopened the existing native remote-backed B, displayed raw README source, observed an outside change to desktop.txt in its clean editor, and restored the file through its terminal. This wrapper is verification scaffolding, not an application launch feature.

Browser transport was exercised with the native loopback URL on port 5191, bypassing the same-origin proxy. The copy stayed empty and terminal showed `Git fetch failed: Load failed`, as expected for the server without CORS headers. Source exposes no browser credential provider. This is a demonstrated transport limit, not a GitHub compatibility claim. That interaction exposed misleading 0/0 counts before any fetched head existed; the footer now requires a known remote-tracking head before showing ahead/behind.

### Browser disjoint merge

After source integration, computer use reopened browser A at its clean divergence: local ecf81cc (terminal.txt), fetched a5741e8 (desktop.txt from native B), both from seed fa3d0e6. Clicking Merge produced a5b1dad, added desktop.txt while retaining terminal.txt, and terminal reads showed native editor and replacement respectively. Browser pushed the merge through the smart HTTP proxy. Independent bare Git inspection confirmed:

```text
a5b1dadd50c859c5252b4c6b98ca58e5c6ec97a9
ecf81cc4dd24a1a658b706b5168a4216c7ff5314 a5741e871d0518d42f49cb82b5595031987bde8f
```

Codex reproduced 128 focused folder Git tests with zero failures before review repairs. Reviewer found additional completion/publication edges: original local head validation, early Bun durable merge identity, and completed-merge leftover-journal clearing. OPFS clear-only recovery now has a real removal-failure regression: later resolution edits survive reopening and recovery, and original index stages and branch remain unchanged. The isolated native and integrity workers own the remaining repairs. The proposed staged-journal corruption was disproved by executable review: backend settled() guards keep branch/index/journal unchanged; moving public admission under protection still improves the typed refusal.

### Browser conflict and resolution

Computer use opened a fresh independent browser B on a5b1dad, edited green and committed 2ef5455. Browser A edited red and pushed 8d5aae9. B stayed green before and after fetch, moving from 1/0 to 1/1 ahead/behind only after fetch. Merge displayed editable green/red markers, UU status, and Merge in progress. An unresolved commit failed visibly with U notes/color.txt and exit 128. Closing and reopening retained the markers and UU state. Editing purple and running status saved text but kept UU. Explicit add changed the index status to M, with the merge banner still visible. Closing and reopening after staging retained that banner and the staged resolution. Commit and push produced d34cb57; independent bare Git verified exactly the original parents:

```text
d34cb572dfbf6cd0e7f3a60ba73c2c24e5364df3
2ef5455431baf999b1a4436c8ff71496db19cde2 8d5aae98841bb187e6b841302a18cd6b49a95b87
```

A still showed red until it fetched, which changed its relationship to 0 ahead / 2 behind without changing the editor. Pull then fast-forwarded and the clean editor showed purple. Native B independently pulled the earlier disjoint merge, received terminal.txt only after pull, and has committed its own green divergence ec72df4 for the upcoming native conflict journey. Native merge support remains under implementation, so no native conflict completion is claimed yet.

Long terminal output left new failures below the visible viewport. The page now follows appended output while at the bottom, and stops following when the person scrolls back. This is a UI observation, not a new shell lifecycle.
