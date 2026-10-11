# OPFS clean break review, 2026-10-04

The user authorized a clean break for the apps already moved to OPFS folders:
Vocab, Whispering, and Todos. These apps no longer read, copy, or delete
earlier IndexedDB data. They have no fallback, compatibility flag, or
recovery utility for it. The concurrent Folder change removes the opener's
IndexedDB copy and the IndexedDB in its test storage helper. This review
covers only the app side. The coordinator handles the root files, the Capture
seam tests and smoke, the Honeycrisp seam, and the Todos host comments.

## Files read before analysis

```text
apps/
|-- vocab/
|   |-- README.md, CHANGELOG.md, package.json, vite.config.ts
|   |-- evidence/opfs-migration.md, local-folder-journey.md
|   `-- src/
|       |-- lib/
|       |   |-- legacy-import.ts, legacy-source.ts (full)
|       |   |-- legacy-import.test.ts (lines 1-140 and the test list)
|       |   |-- boot-node.test.ts, data.ts, data.test.ts
|       |   |-- folder.ts, folder.test-support.ts, entries.svelte.ts
|       |   |-- entries.test.ts (add and other-name regions)
|       |   `-- chat/messages.ts (listChats), messages.test.ts (message-only chats)
|       `-- routes/components/
|           |-- VocabShell.svelte, WordsView.svelte
|           `-- LegacyImport.svelte
|-- whispering/
|   |-- ARCHITECTURE.md (storage table), README.md (earlier-build regions)
|   |-- docs/desktop-verification.md (browser check table)
|   |-- evidence/opfs-migration.md (full), migration-review.md (regions)
|   `-- src/lib/workspace/types.ts, browser.ts (full),
|       desktop.test.ts (header and storage tests), browser.test.ts (grep)
|-- todos/
|   |-- package.json, svelte.config.js, README.md (browser demo)
|   `-- src/lib/incoming.test.ts, platform-selection.test.ts,
|       platform/folder.browser.ts, platform/folder.epicenter-host.ts (header)
`-- honeycrisp/package.json, plus a grep for fake-indexeddb imports
packages/folder/src/
|-- browser-storage.test-support.ts
|-- browser-adapter.ts (opener and storage checks)
`-- errors.ts (OpenFolderError)
```

## Coordinator read inventory

```text
.agents/skills/
|-- delegate-claude/SKILL.md
|-- post-implementation-review/SKILL.md
|-- typescript/SKILL.md
|-- svelte/SKILL.md
|-- consult-claude/scripts/consult-claude.ts (launcher opening)
`-- rethink/references/radical-options.md
docs/adr/README.md (all 757 lines, read-only)
apps/
|-- vocab/
|   |-- README.md, package.json
|   `-- src/
|       |-- lib/folder.ts, folder.test-support.ts, boot-node.test.ts
|       `-- routes/components/WordsView.svelte
|-- whispering/
|   |-- package.json
|   `-- src/lib/workspace/types.ts, browser.test.ts (opening)
|-- todos/
|   |-- package.json
|   `-- src/lib/incoming.test.ts, platform-selection.test.ts,
|       platform/folder.epicenter-host.ts
|-- honeycrisp/README.md, src/lib/platform-selection.test.ts
`-- capture/
    |-- README.md, package.json (scope evidence)
    |-- scripts/browser-smoke.ts
    `-- src/lib/
        |-- platform-selection.test.ts
        |-- components/Recovery.svelte (scope evidence, unchanged)
        `-- recovery/legacy-account.ts (scope evidence, unchanged)
```

The coordinator flagged the supplemental findings before edits. The Todos,
Capture, and Honeycrisp browser module graphs required the retired
`browser-store.ts`; their desktop exclusions would miss `opfs-store.ts`.
They now require OPFS and reject the retired IDB store, migration, and fake
IndexedDB dependency. Capture smoke and Todos host comments named the wrong
storage owner. The comments now describe OPFS or a refusal to open browser
storage. Capture and Honeycrisp current READMEs also promised an IDB copy;
those paragraphs now state OPFS-only opening. File organization stays the same; each platform seam owns its build
selection. Capture account recovery remains outside this Folder clean break.
The edited supplemental files were reread in full. No helper or API changed.
The final reread also flagged an unnecessary cast in the new global guard
test: restoring absent globals used a `Record` cast for dynamic deletion.
`Reflect.deleteProperty` now performs the deletion without that cast.

The complete ADR index was reread without edits by this coordinator. The
0498 row withdraws the retired import obligation while preserving native
and configured synchronization work. Historical application-store IndexedDB
records describe a separate store family and stay unchanged.

## Findings

1. Vocab's earlier-account import was a closed family:
   `legacy-import.ts`, `legacy-source.ts`, `LegacyImport.svelte`, and
   `legacy-import.test.ts`. Its only caller was `VocabShell.svelte`.
   `WordsView`'s `children` snippet existed only to hold the panel. Its
   wrapper's `pb-24` also kept the last word clear of the floating start
   button. `boot-node.test.ts` had a test that existed only to allow the
   import's store opener.
2. The Vocab README said an earlier IndexedDB folder is copied on first open,
   and it described the import panel.
3. `entries.svelte.ts` and `entries.test.ts` justified the text lookup by
   "an imported" word. The lookup is still needed: any file in `entries/` can
   have a stem that is not its text hash. Only the wording changed.
4. Whispering's `WorkspaceError.BrowserFolder` rewrote `NoIndexedDb` into an
   earlier-version message. The `browser.ts` header said IndexedDB was needed
   to check earlier files, and `ARCHITECTURE.md` said the IndexedDB folder is
   copied once. `desktop.test.ts` pinned `NoIndexedDb` for a process without
   browser storage.
5. Todos' `incoming.test.ts` imported `fake-indexeddb` only to create a
   storage identity. `platform-selection.test.ts` required the IndexedDB store
   module in the browser build and named `fake-indexeddb`. The README promised
   the IndexedDB copy, and `svelte.config.js` said the folder lives in
   IndexedDB.
6. Honeycrisp lists `fake-indexeddb` but never imports it.

## Organization

Current, before this change:

```text
apps/vocab/src/
|-- lib/
|   |-- data.ts                 folder declaration, row readers, focusWord
|   |-- folder.ts               opens the one OPFS folder
|   |-- entries.svelte.ts       saved word list and admission
|   |-- word.svelte.ts          one word's editor lifetime
|   |-- reread.ts
|   |-- inference.ts
|   |-- legacy-import.ts        earlier store declarations and the copy
|   |-- legacy-source.ts        opens the earlier stores on request
|   `-- chat/chats.svelte.ts, messages.ts, session.svelte.ts
`-- routes/components/
    |-- VocabShell.svelte
    |-- WordsView.svelte        children slot for the panel
    `-- LegacyImport.svelte
```

Proposed and implemented:

```text
apps/vocab/src/
|-- lib/
|   |-- data.ts
|   |-- folder.ts
|   |-- entries.svelte.ts
|   |-- word.svelte.ts
|   |-- reread.ts
|   |-- inference.ts
|   `-- chat/chats.svelte.ts, messages.ts, session.svelte.ts
`-- routes/components/
    |-- VocabShell.svelte
    `-- WordsView.svelte        no slot; owns its bottom padding
```

The owners that remain keep their jobs. `data.ts` owns the declaration and
`focusWord`, and `folder.ts` owns acquisition. `entries.svelte.ts` owns the
list and admission, and `word.svelte.ts` owns one word's editor. The chat
modules own chats, messages, and the tutor loop. In Whispering,
`workspace/types.ts`, `browser.ts`, and `desktop.ts` keep the storage seam
and acquisition. Todos keeps `platform/` as its seam. No file moved or merged.

## Changes

Deleted:

- `13f7c93559:apps/vocab/src/lib/legacy-import.ts`
- `13f7c93559:apps/vocab/src/lib/legacy-source.ts`
- `13f7c93559:apps/vocab/src/lib/legacy-import.test.ts`
- `13f7c93559:apps/vocab/src/routes/components/LegacyImport.svelte`
- The `LegacyImport` callsite in `VocabShell.svelte`
- The `children` snippet in `WordsView.svelte`. Its bottom padding moved to
  the scroll container.
- The legacy-only part of the `boot-node.test.ts` store-opener check. The
  test now requires that no shipped source opens a store.
- The README section "Words and chats from earlier Vocab" and its copy
  promise. The README now states the clean break.
- The `NoIndexedDb` message branch in `apps/whispering/src/lib/workspace/types.ts`
- The IndexedDB sentence in `apps/whispering/src/lib/workspace/browser.ts`
- `fake-indexeddb` from `apps/todos/package.json` and
  `apps/honeycrisp/package.json`

Changed:

- `apps/whispering/src/lib/workspace/desktop.test.ts` expects
  `NoFileSystem` from a process with no OPFS. The workspace message must be
  the folder's message.
- `apps/todos/src/lib/incoming.test.ts` uses `createTestStorage()` as the
  storage identity, through `browserStorage(storage)` and `opfsOf(storage)`.
  The Git incoming recovery tests are unchanged.
- `apps/todos/src/lib/platform-selection.test.ts` requires `opfs-store.ts` in
  the browser build, and forbids it in the host build, where it replaces
  `browser-store.ts`.
- `apps/vocab/src/lib/data.test.ts` has two new tests:
  - Global IndexedDB guard: it saves a word on a first open and reads it back
    after a reopen. Throwing getters stand in for `globalThis.indexedDB` and
    `IDBKeyRange` during the test, and the descriptors are restored
    afterward. Its limit is under "Checks and limitations".
  - `focusWord`: the test moved from the deleted import tests. See the
    post-edit review.
- The acceptance records in both apps' `evidence/opfs-migration.md` now
  acknowledge the clean break. `local-folder-journey.md` and
  `migration-review.md` are labeled historical and stay unchanged otherwise.

## Post-edit review

### Full reread inventory

Every retained touched file was read in full after editing. The deleted
files were also read in full. Three of them were read from the working tree
before deletion, where they matched `HEAD`. The rest of
`legacy-import.test.ts` (lines 136-449) was read with `git show HEAD:`.

```text
apps/
|-- vocab/
|   |-- README.md
|   |-- evidence/
|   |   |-- local-folder-journey.md
|   |   |-- opfs-migration.md
|   |   `-- opfs-clean-break-review.md
|   `-- src/
|       |-- lib/
|       |   |-- boot-node.test.ts
|       |   |-- data.test.ts
|       |   |-- entries.svelte.ts
|       |   `-- entries.test.ts
|       `-- routes/components/
|           |-- VocabShell.svelte
|           `-- WordsView.svelte
|-- whispering/
|   |-- ARCHITECTURE.md
|   |-- evidence/
|   |   |-- migration-review.md
|   |   `-- opfs-migration.md
|   `-- src/lib/workspace/
|       |-- browser.ts
|       |-- types.ts
|       `-- desktop.test.ts
|-- todos/
|   |-- README.md
|   |-- package.json
|   |-- svelte.config.js
|   `-- src/lib/
|       |-- incoming.test.ts
|       `-- platform-selection.test.ts
`-- honeycrisp/package.json

Deleted, read in full from HEAD:
apps/vocab/src/lib/legacy-import.ts
apps/vocab/src/lib/legacy-source.ts
apps/vocab/src/lib/legacy-import.test.ts
apps/vocab/src/routes/components/LegacyImport.svelte

Context for the guard-test correction:
packages/folder/src/browser-migration.ts (IndexedDB use)
packages/folder/src/browser-adapter.ts (call to prepareFolderDirectory)
```

### Findings after the reread

These were reported before any fix.

1. Lost coverage. Fixed. The deleted `legacy-import.test.ts` was the only
   test of `focusWord`, which `data.ts` still exports and `FocusWords.svelte`
   uses. The rule is that a focus stage control never acts on a word with
   other text at the same ID. That test, "a focus never controls a word with
   another text", used only the current folder. It now lives in
   `data.test.ts` and reads its rows through `readRows` and `readEntry`.
   The other deleted tests covered import behavior only. `messages.test.ts`
   already covers message-only chats.
2. Overstated evidence. Corrected. The first version of this review said the
   global IndexedDB guard does not depend on the Folder version. That was
   wrong. `createBrowser` calls `testBrowserStorage()`. At the worker baseline, that
   helper builds a fake IndexedDB and passes it to the real opener as
   `opfs.indexedDb`. On each address's first open, the opener then calls
   `environment.indexedDB.open(...)` in `browser-migration.ts` (line 89) on
   that injected database. The guard only sees the globals, so it passes
   while that read happens. The test name and comment now limit the claim to
   the globals.
3. Evidence wording. Corrected. The Vocab acceptance note said Vocab copied
   the IndexedDB folder. The shared browser opener did, so the note now says
   so.
4. Reported, not fixed. In a tab without OPFS, Whispering shows the folder's
   `NoFileSystem` message unchanged. That message is written for developers
   ("origin private file system ... navigator.storage..."). A tab with
   IndexedDB but no OPFS already got this message before the clean break.
   App-specific wording would be new UI copy, which is outside this brief.

Other checks on the reread:

- The removals leave no dead export, import, or prop. `VocabTables`, `auth`,
  `startSignIn`, and `folder` in `VocabShell` all still have callers.
- `@epicenter/app/field` and the inference openers keep the
  `@epicenter/app` dependency.
- There are no new helpers or wrappers.
- `ARCHITECTURE.md` still says a refusal is shown as it is, and the removed
  branch matches that.
- The evidence notes describe the opener's copy as removed. That is true only
  once the concurrent Folder change is integrated.

## Remaining non-IndexedDB legacy, and why it stays

- Vocab message-only chats (`listChats`, `legacy: true`): messages whose chat
  has no `chats/` file are a current OPFS file shape, read from the folder.
- Vocab's `@epicenter/app` use: `@epicenter/app/field` (`InstantString`,
  `jsonValue`) and the inference openers are current.
- Whispering's `legacyKey`, `LEGACY_KEY_STORAGE`, `adoptLegacyKey`, and the
  native device-file key: one key that an earlier build kept in
  `localStorage` or the native settings file, moved only when the person asks.
- Whispering's `kv.json` legacy settings and recipe endpoint constraints:
  folder files an earlier build wrote, read in place and never written.
- Capture's account recovery and other apps' Yjs or IndexedDB stores are out
  of scope and unchanged.

## Worker clone checks and limitations

The sandbox cannot read `node_modules`. Every app's `node_modules` links to a
worktree under the user's home directory, and the sandbox denies reads there.
These commands were attempted:

| Command | Outcome |
| --- | --- |
| `bun test apps/vocab/src/lib/boot-node.test.ts apps/vocab/src/lib/import.test.ts` | 7 pass, 0 fail. Neither file imports a package. |
| `bun test apps/vocab/src/lib` (first pass) | 7 pass, 10 fail, 10 errors. Each error was `Cannot find module` or `Cannot find package`, for example `@epicenter/agent`, `@epicenter/app/field`, `wellcrafted/testing`, `jsdom`, `openai`. |
| `bun test apps/vocab/src/lib/data.test.ts apps/vocab/src/lib/boot-node.test.ts` (after the post-edit fixes) | 6 pass (boot-node), 1 fail, 1 error: `data.test.ts` cannot find `@epicenter/app/field`. |
| `bun test apps/whispering/src/lib/workspace/desktop.test.ts` | 0 pass, 1 fail, 1 error, at module resolution. |
| `bun test apps/todos/src/lib/incoming.test.ts` | 0 pass, 1 fail, 1 error, at module resolution. |
| `bun run typecheck` in `apps/vocab` | Exit 127: `svelte-kit: command not found`. |
| `git diff --check` on the touched app paths | Pass. |

A later batch attempt was refused by the tool permission mode, so these
never ran:

- the Whispering and Todos typechecks
- all three builds
- `platform-selection.test.ts`

The coordinator will run them with live dependencies.

What depended on the concurrent Folder change at the worker baseline:

- `createTestStorage()` does not exist in this checkout's Folder test
  support. `incoming.test.ts` needs the Folder helper change.
- The worker baseline opener checked for IndexedDB before OPFS, so the two
  `desktop.test.ts` assertions need the Folder opener change to see
  `NoFileSystem`.
- At that baseline, the guard test passed even though the opener read the injected fake
  IndexedDB. It shows an IndexedDB-free fresh open and reopen only together
  with the Folder helper and opener changes.

Other limits:

- `bun.lock` still lists `fake-indexeddb` for Todos and Honeycrisp.
  Refreshing the lock file is left to integration.
- No browser journey exercised the clean break.

## Integrated coordinator acceptance

The Folder source and test helper changes are now integrated in the live
checkout. Its test storage is a `MemoryOpfs` tree, with no injected IndexedDB.
The Vocab global guard passes while saving, closing, reopening, and reading
the saved word. Together with the IDB-free helper and opener, that exercises
the fresh and reopened OPFS path without IndexedDB.

Final live checks, after Folder integration:

| Command | Result |
| --- | --- |
| `bun test apps/vocab/src/lib` | 97 pass, 0 fail; 616 assertions across 12 files. |
| `bun test --isolate apps/whispering` | 444 pass, 0 fail; 3,229 assertions across 25 files. |
| `bun test --isolate apps/todos/src/lib/incoming.test.ts apps/todos/src/lib/platform-selection.test.ts` | 8 pass, 0 fail; 98 assertions. Explicit interrupted Git recovery stays covered. |
| `bun test --isolate apps/capture/src/lib/platform-selection.test.ts apps/honeycrisp/src/lib/platform-selection.test.ts` | 4 pass, 0 fail; 27 assertions. Browser graphs contain OPFS and exclude retired IDB modules. |
| Vocab, Whispering, Todos, Honeycrisp, and Capture `typecheck` | All exit 0. Every Svelte check reports 0 errors and 0 warnings; native/script TypeScript checks also pass. |
| Vocab and Whispering `build` | Both production builds exit 0. Each ran after its typecheck. |
| `git diff --check` on the affected app paths | Pass. |

The dependency failures above describe the worker clone; they do not describe
these live results. Logs are in `/tmp/apps-clean-break-*`. The coordinator
left root lock staging and real-browser acceptance to their respective owners.
No real account sign-in, model call, microphone capture, or native GUI was
performed by this app implementation assignment. The historical screenshots
in the earlier migration records are not new clean-break browser evidence.
