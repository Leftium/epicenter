```text
Files read (both phases; * = touched and re-read in full after editing)
repository/
|-- AGENTS.md
|-- .cleanup-input/delegate-claude.md
|-- .agents/skills/
|   |-- collapse-pass/SKILL.md
|   |-- collapse-pass/references/never-touch.md
|   |-- collapse-pass/references/report-format.md
|   |-- post-implementation-review/SKILL.md
|   `-- platform-seams/SKILL.md
|-- apps/honeycrisp/
|   |-- AGENTS.md
|   |-- CLAUDE.md
|   |-- README.md
|   |-- CHANGELOG.md
|   |-- .gitignore
|   |-- package.json
|   |-- vite.config.ts
|   |-- svelte.config.js *
|   |-- wrangler.jsonc
|   |-- tsconfig.json
|   |-- tsconfig.scripts.json
|   |-- tsconfig.tauri.json
|   |-- evidence/desktop/
|   |   |-- README.md
|   |   `-- review.md
|   |-- host/
|   |   |-- main.ts
|   |   |-- serve.ts *
|   |   |-- serve.test.ts
|   |   |-- faults.ts *
|   |   |-- terminal.ts
|   |   `-- watch.ts
|   |-- scripts/
|   |   |-- build-host.ts
|   |   `-- module-graph.ts
|   |-- smoke/account-popover/
|   |   |-- App.svelte
|   |   |-- fixture.mjs
|   |   |-- index.html
|   |   `-- main.ts
|   |-- src-tauri/
|   |   |-- Cargo.toml
|   |   |-- tauri.conf.json
|   |   |-- frontend-placeholder/index.html
|   |   `-- src/
|   |       |-- lib.rs
|   |       `-- main.rs
|   `-- src/
|       |-- app.html
|       |-- lib/
|       |   |-- data.ts *
|       |   |-- date-label.ts
|       |   |-- line-diff.ts
|       |   |-- files.ts
|       |   |-- status.ts
|       |   |-- draft.svelte.ts *
|       |   |-- draft.test.ts *
|       |   |-- note-source.ts
|       |   |-- note-source.test.ts
|       |   |-- notes.svelte.ts *
|       |   |-- terminal.svelte.ts
|       |   |-- platform-selection.test.ts
|       |   |-- svelte-modules.test-support.ts
|       |   |-- bridge/
|       |   |   |-- codec.ts
|       |   |   |-- contract.ts
|       |   |   |-- folder-client.ts *
|       |   |   `-- notes-host.ts *
|       |   |-- platform/
|       |   |   |-- types.ts
|       |   |   |-- notes-host.browser.ts
|       |   |   `-- notes-host.tauri.ts
|       |   |-- shims/zlib.ts
|       |   `-- editor/
|       |       |-- schema.ts
|       |       |-- markdown.ts
|       |       |-- markdown.test.ts        (lines 1-60)
|       |       |-- markdown.fuzz.test.ts   (lines 1-60)
|       |       |-- rich-session.ts *
|       |       `-- rich-session.test.ts *
|       `-- routes/
|           |-- +layout.svelte
|           |-- +layout.ts
|           |-- +page.svelte
|           `-- components/
|               |-- NotesView.svelte
|               |-- AppHeader.svelte
|               |-- DraftStatus.svelte
|               |-- FaultPanel.svelte
|               |-- FileBrowser.svelte *
|               |-- FileNameBar.svelte
|               |-- FileView.svelte *
|               |-- FolderNav.svelte
|               |-- FolderTerminal.svelte
|               |-- NoteDetail.svelte *
|               |-- NoteHistory.svelte *
|               |-- NoteList.svelte
|               |-- RichEditor.svelte
|               `-- file-actions.ts
`-- read-only callers
    |-- packages/auth/smoke/dashboard.browser.mjs        (lines 130-189)
    |-- packages/app-shell/smoke/app-boot.browser.mjs    (lines 35-84)
    |-- packages/app/src/files/folder.ts                 (grep hits: signal, close)
    |-- packages/app/src/files/index.ts                  (grep hits: close)
    |-- apps/epicenter/package.json                      (grep hits)
    |-- apps/epicenter/AGENTS.md                         (grep hit, line omitted as too long)
    |-- apps/capture/package.json                        (grep hit)
    |-- apps/capture/svelte.config.js                    (grep hit)
    |-- apps/capture/vite.config.ts                      (grep hit)
    |-- apps/whispering/package.json                     (grep hit)
    |-- apps/whispering/svelte.config.js                 (grep hit)
    |-- apps/whispering/vite.config.ts                   (grep hit)
    |-- apps/local-mail/package.json                     (grep hit)
    |-- apps/vocab/svelte.config.js                      (grep hit)
    |-- apps/README.md                                   (grep hits)
    |-- package.json                                     (grep hits)
    |-- jsrepo.config.ts                                 (grep hit with context)
    |-- scripts/check-boot-purity.ts                     (grep hits with context)
    |-- scripts/epicenter.test.ts                        (grep hits with context)
    |-- scripts/check-vocabulary.ts                      (grep hit)
    |-- packages/auth/README.md                          (grep hit with context)
    |-- packages/ui/package.json                         (grep hits)
    `-- packages/app/package.json                        (grep hit)
```

Groups 1, 2 and 3 are implemented in `apps/honeycrisp` only. Tests, typecheck, Biome and the browser build pass; the desktop-ui build could not run in this sandbox and needs a coordinator run.

## What changed and why

Each item keeps the reasoning from the proposal.

### Group 1: dead component props from an older layout

- **`FileBrowser` `onOpen` removed.** Its only mount, `NotesView.svelte:142`, passes `notes` alone, so both `onOpen?.()` calls were no-ops.
- **`FileView` `onBack` removed.** Its only mount, `NotesView.svelte:126`, never passed it, so the Back button never rendered. Its comment described a narrow-screen layout that no longer exists. The `ArrowLeftIcon` import went with it.
- **`NoteHistory` takes `history` instead of `notes`.** The only mount (`NoteDetail.svelte:203-205`) already sits inside `{#if notes.host.history && historyOpen}`, so the two internal guards were unreachable. The prop type is `NonNullable<NotesHost['history']>`, the same shape `FaultPanel` uses for `faults`.

### Group 2: zero-caller surface

- **`notes.openNote` removed** (0 callers). Every caller holds a path and calls `notes.open`. `notePath` stays; `saveDraftAsNote` uses it.
- **`FolderHost` and `FaultInjector` types removed** (0 callers each).
- **`FolderId` type removed** (0 uses). `NoteId` stays.
- **`createRemoteFolder`'s `signal` option and `folder.signal` removed.** One writer, no reader: `NotesFolder` picks only `tables | kv | files | git`. The transport's `lifetime.signal` passed to `listen` is untouched.
- **`FOLDERS` const removed.** The page now derives its table list with `Object.keys(honeycrispDefinition.tables)`, the same expression the host uses at `serve.ts:135`.
- **`Draft.adoptions` and `RichSession.replacements` removed, with their five assertions.** Both were test-only counters whose comments named production readers that do not exist. Every other assertion in those tests is kept. The test "observing the same bytes changes nothing and counts no adoption" is renamed "observing the same bytes changes nothing".

### Group 3: standalone clean break

- **`svelte.config.js` no longer has an Epicenter-host branch.** No script in the app set `EPICENTER_HOST`, and `evidence/desktop/review.md:88` records that `build:epicenter` was removed deliberately. Output is now `isDesktop ? 'build-desktop' : 'build'`, the `paths.base` spread is gone, and the header comment drops its third sentence.

## Changed paths

All under `apps/honeycrisp/`; 15 files, 18 insertions, 65 deletions. No file was added, moved or deleted.

- `host/faults.ts`
- `host/serve.ts`
- `src/lib/bridge/folder-client.ts`
- `src/lib/bridge/notes-host.ts`
- `src/lib/data.ts`
- `src/lib/draft.svelte.ts`
- `src/lib/draft.test.ts`
- `src/lib/editor/rich-session.ts`
- `src/lib/editor/rich-session.test.ts`
- `src/lib/notes.svelte.ts`
- `src/routes/components/FileBrowser.svelte`
- `src/routes/components/FileView.svelte`
- `src/routes/components/NoteDetail.svelte`
- `src/routes/components/NoteHistory.svelte`
- `svelte.config.js`

Untouched as instructed: `evidence/desktop/**`, `package.json`, `bun.lock`, `HostInfo.shell`, `smoke/`, `src-tauri/`, and everything outside the app.

## Tree

```text
Current and proposed are the same; only surface shrank.
apps/honeycrisp/
|-- host/          main, serve, faults, terminal, watch
|-- scripts/       build-host, module-graph
|-- smoke/account-popover/
|-- src-tauri/
`-- src/
    |-- lib/       data, draft, notes, note-source, files, status, terminal,
    |   |          date-label, line-diff
    |   |-- bridge/    codec, contract, folder-client, notes-host
    |   |-- platform/  types, notes-host.browser, notes-host.tauri
    |   |-- editor/    schema, markdown, rich-session
    |   `-- shims/     zlib
    `-- routes/components/   13 components + file-actions.ts
```

## Second-read review

Every touched file was re-read in full after editing.

| File | Inline test | Smell check | Invariant audit | API shape |
| --- | --- | --- | --- | --- |
| `FileBrowser.svelte` | `activate` and `commit` read straight through with no callback hop | No dead prop, import or branch left | Focus restore after create and rename unchanged | One prop, `notes` |
| `FileView.svelte` | Header is icon, name, path, copy button | `Button` still used twice; no orphan import | Draft status and discard path unchanged | `notes`, `path`, `file` |
| `NoteHistory.svelte` | `history.log` and `history.show` called directly; no guards | Two `svelte-ignore` lines remain, both needed (see below) | "Use this version" still only calls `editor.input`; nothing is saved | `history`, `editor`, bindable `open` |
| `NoteDetail.svelte` | Mount passes the already-narrowed `notes.host.history` | None | Rich view stays mounted while Source shows; comment kept | Unchanged |
| `notes.svelte.ts` | `open` is the one entry for selecting a path | `notePath` import still used at line 642 | Draft retention, settle-before-rename and delete all unchanged | One fewer method |
| `data.ts` | `NOTES` used by `notePath` and `notes.svelte.ts` | No orphan export | Header doc on stem identity and `folderId` kept | Two fewer exports |
| `bridge/notes-host.ts` | Table list derived from the declaration, as on the host | `lifetime` still owns `listen` and `close` | `closePending`, `deliverClose`, and the reconnect reread are untouched | Unchanged |
| `bridge/folder-client.ts` | `createRemoteFolder` takes `tables` and `snapshot` | No unread property on the folder object | Header doc on `Result` passthrough and throw-on-transport-failure kept | One fewer option |
| `draft.svelte.ts` | `adopt` sets accepted, buffer, and clears the three flags | No unread `$state` | Header doc on the four separate facts kept verbatim; `accepted`, `buffer`, `inFlight`, `external` still separate | One fewer getter |
| `draft.test.ts` | Adoption tests assert `buffer`, `accepted`, `phase`, `writes` | Renamed test title matches its body | All behavior assertions kept | n/a |
| `rich-session.ts` | `sync` replaces state and returns it | No unread counter | Header doc and `syncedBody` doc kept; undo reset on external body change still via `stateFor` | One fewer getter |
| `rich-session.test.ts` | Undo reset still asserted by `undoDepth` 0 and the follow-up undo | None | Continuous-session and reset tests keep their behavior assertions | n/a |
| `host/serve.ts` | Unchanged apart from the removed type alias | `FolderHostOptions` still used by the test | Commit-after-save comment, origin and token checks, close retention untouched | One fewer export |
| `host/faults.ts` | Unchanged apart from the removed type alias | None | Header doc on hold-before-read kept | One fewer export |
| `svelte.config.js` | Two outputs, one condition | No reference to a host build | Browser and desktop outputs unchanged | n/a |

Table order from `Object.keys` is `folders, notes` rather than `notes, folders`. It only affects key order on the page's `folder.tables` object; nothing reads it positionally, and the host tests exercise both tables through the bridge.

**No new defect found on the second read.** One thing I tested rather than assumed: the second `svelte-ignore` in `NoteHistory.svelte`. I removed it, svelte-check reported a `state_referenced_locally` warning at 21:20 in both passes, and I restored it. The count of ignores in that file is therefore unchanged at two.

## Checks

Run from `apps/honeycrisp`.

| Command | Result |
| --- | --- |
| `bun test --isolate` | 150 pass, 0 fail, 410 assertions, 7 files (baseline 415; the five removed are the counter assertions) |
| `bun run typecheck` | Browser and Tauri svelte-check: 0 errors, 0 warnings; scripts `tsc` passed |
| `bun x biome check --diagnostic-level=error .` | "Checked 53 files. No fixes applied." |
| `bun run build` | Passed; "Wrote site to \"build\"" |
| `bun run build:desktop-ui` | **Not run.** Exit 127: the nested shell cannot find `bun`. The direct equivalent with env prefixes was denied by the sandbox. |

Re-grep for `onOpen`, `onBack`, `ArrowLeftIcon`, `openNote`, `FolderHost` (bare), `FaultInjector`, `FolderId`, `FOLDERS`, `adoptions`, `replacements`, `EPICENTER_HOST`, `isEpicenterHost` across `src`, `host`, `scripts`, `smoke`, and the app's top-level files: zero hits. The only remaining `.signal` is `lifetime.signal` at `bridge/notes-host.ts:53`, which is intended.

## Simplified surface

```text
Exports removed: 4   (FolderHost, FaultInjector, FolderId, FOLDERS)
Members removed: 4   (notes.openNote, Draft.adoptions, RichSession.replacements, remote folder.signal)
Options removed: 1   (createRemoteFolder signal)
Props removed:   2   (FileBrowser onOpen, FileView onBack); NoteHistory notes -> history
Config branches: 1   (svelte.config.js Epicenter host)
Files added/removed: 0
```

## Residual issues

- **Desktop-ui build is unverified here.** Please run `bun run --cwd apps/honeycrisp build:desktop-ui` with `.tools` on PATH. The Tauri-condition svelte-check and the platform-selection bundle test of the desktop leaf both pass, which covers the changed bridge files but not the full Vite build.
- **`build/` exists in the clone** from the browser build check. It is gitignored and does not appear in `git status`.
- **`apps/epicenter/package.json:16`** still calls the removed `build:epicenter`; you are handling that in the live checkout.
- **Reported earlier, not touched:** `HostInfo.shell` has no reader; `fake-indexeddb`, `bits-ui` and `svelte-sonner` have no imports in the app; `app.html` links a `favicon.ico` that does not exist; stale Honeycrisp mentions in `apps/README.md:88`, `packages/auth/README.md:154` and `jsrepo.config.ts:24`; Epicenter's routes and catalog still list Honeycrisp.

Nothing is staged or committed.
