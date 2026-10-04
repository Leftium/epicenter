# OPFS clean-break coordinator review

## Read inventory before analysis

Worker inventories list every file they read before analysis and distinguish
full reads from excerpts. Each implementation owner reread every returned
file in full, including deleted baseline files, before integration. The root
review also read the relevant whole-file opener, storage fixture, final ADRs,
worker records, independent reports and cumulative diffs. This does not claim
that root independently reread every large application file.

```text
epicenter/
|-- .agents/skills/
|   |-- adversarial-review/SKILL.md
|   |-- consult-claude/SKILL.md
|   |-- delegate-claude/SKILL.md
|   |-- computer-use-driven-iteration/SKILL.md
|   |-- post-implementation-review/SKILL.md
|   |-- rethink/SKILL.md
|   |-- git/SKILL.md
|   `-- standalone-commits/SKILL.md
|-- apps/
|   |-- README.md
|   `-- vocab/
|       |-- evidence/opfs-clean-break-review.md
|       `-- src/routes/components/VocabShell.svelte (root excerpt; app owner full)
|-- docs/adr/
|   |-- 0476-whisperings-desktop-folder-uses-one-rust-library-in-both-tauri-shells.md
|   |-- 0497-browser-folders-use-scoped-opfs-directories.md
|   |-- 0498-vocab-opens-one-local-folder-before-sign-in.md
|   `-- README.md                         (root row diff; app owner full read)
|-- bun.lock                              (full worker sections and task delta)
`-- packages/folder/
    |-- src/browser-adapter.ts
    |-- src/browser-storage.test-support.ts
    |-- src/browser-identity.test.ts       (root focused; Folder owner full read)
    |-- evidence/opfs-clean-break-review.md
    |-- evidence/bundles/app/{browser,main,tauri}.ts (full prerequisite review)
    |-- evidence/shared-folder-workflow.ts (root partial; Folder owner full)
    `-- evidence/opfs/
        |-- clean-break-gpt-review.md
        `-- clean-break-claude-review.md
zhongwen/
|-- docs/opfs-clean-break-review.md
`-- src/lib/opener.test.ts
```

Additional root reads were task manifests, baseline hashes, native Claude
result artifacts, test/build logs and the cumulative returned diffs. The
complete implementation inventories and file-by-file dispositions are in the
[Folder record](../opfs-clean-break-review.md),
[app record](../../../../apps/vocab/evidence/opfs-clean-break-review.md), and
`/Users/braden/Code/zhongwen/docs/opfs-clean-break-review.md`.

## Scope decision

Browser Folder opens its captured OPFS directory directly. The user refused
IndexedDB recovery, so this change deletes Folder's reader, freeze protocol,
copy cursor, Local admission fence, environment field and legacy error family.
Vocab's earlier-store import UI and helpers disappear. Zhongwen's earlier-store
fixtures and migration tests disappear. No fallback, deletion utility or
replacement migration interface is shipped. Existing OPFS identities and
arbitrary extra marker properties remain unchanged.

Unrelated App/Yjs persistence, blob stores, private SQL, Capture account-bundle
recovery, explicit disk import, and Whispering connection preferences retain
their own contracts. No browser database was deleted.

## Current and resulting organization

```text
Before                              After
folder/src/                         folder/src/
|-- browser-adapter.ts              |-- browser-adapter.ts (claim/open)
|-- browser-migration.ts            |-- browser-identity.test.ts
|-- browser-migration.test.ts       |-- browser-storage.test-support.ts
|-- browser-store.ts                |-- opfs-store.ts
|-- legacy.test-support.ts          `-- git/ (unchanged owners)
|-- opfs-store.ts
`-- git/
vocab/src/lib/legacy-*.ts            removed
vocab/components/LegacyImport       removed
zhongwen/lib/migration.test.ts       opener.test.ts
```

The marker parser and empty-footprint inspection stay local to the opener.
A new module would add a hop with no additional consumer. The test storage
now owns MemoryOpfs directly. `opfsOf` is a forwarding test accessor, retained
as optional cosmetic debt rather than a production invariant owner.

## Findings called out before correction

Both independent reviewers designed from the outcome and real callers. Their
frozen mid-conversion verdicts are preserved, not rewritten as final passes.
The four concrete snapshot blockers were stale app graph assertions, Todos'
fake-IDB fixture, retired migration references in runnable evidence, and
Whispering's `NoIndexedDb` branch. All are resolved in the integrated artifact.

Review also found a vacuous old lock-name bundle assertion, missing emitted
browser-global exclusion checks, an invariant test that would have been lost
with the Vocab legacy tests, a needless dynamic-delete cast, and documentation
still promising the retired copy. Owners called out each finding before
correction and reread the resulting files.

The independent reports agree that captured identity, publication ordering,
stable audio bytes and explicit incoming recovery still earn their boundaries.
Raw handles would distribute these policies to apps. Dropping the marker would
adopt unknown bytes. Neither is a sound deletion for the accepted guarantees.

Typed identity refusal, baseline-adapter compatibility machinery and broad
power-loss recovery were not added. They lack a required caller or promise.
The isolated global-descriptor assertion is documented as a test-runner
assumption. The Claude report's claim that clearing all site data is the only
manual escape is too broad: targeted external repair can exist without a
shipping tool. This change prescribes neither site clearing nor user recovery.

## Automated acceptance

| Check | Observed result |
| --- | --- |
| Folder full live suite | 676 pass, 18 skip, 0 fail; 3,821 assertions |
| Folder final identity checks | 13 pass; absent and throwing globals, bytes/history reopen |
| Folder bundle checks | 5 pass; no IndexedDB globals in browser output |
| Folder live types and OPFS evidence build | pass |
| Vocab | 97 pass; 616 assertions |
| Whispering | 444 pass; 3,229 assertions |
| Todos incoming and graph | 8 pass; 98 assertions |
| Capture/Honeycrisp graphs | 4 pass; 27 assertions |
| All five Epicenter app typechecks | pass |
| Vocab/Whispering production builds | pass |
| Epicenter frozen install | pass, no lock rewrite |
| Zhongwen Bun/mounted tests | 57 / 31 pass |
| Zhongwen types, frozen install, snapshot checks, clone/live build | pass |

The task-start Folder baseline passed 685 tests with 18 skips. Retired migration
coverage was deleted and current identity coverage added; a smaller total is
not a claim that skipped coverage ran. Zhongwen's temporary failures against
its old snapshot were API drift before the new snapshot arrived, not final
failures. Dedicated worker-clone missing evidence plugins were checked against
that clone's baseline; final live package types pass.

## Browser acceptance and limits

Root completed computer-use acceptance in Chrome 142 against the final live
sources and production builds:

- Vocab at `http://localhost:8888/`: fresh open; added 顺便, saved the Unicode
  note and Recognize stage, reloaded and found both unchanged; created a chat,
  reloaded, reopened it and found the same expression and stage in its focus.
  No inference model was configured, so no provider request was tested.
- Zhongwen at `http://127.0.0.1:5207/`: final live production preview reopened
  seven expressions, Pinyin preference and the existing Recognize stage.
  Saved a note on the existing test entry and verified it after reload.
  Existing conversation `5ynm25p35u` still has eight Tutor and seven You turns.
  A stale preview produced a transient 500; restarting the final production
  preview resolved the route. No source repair was required.
- Whispering at `http://localhost:5235/recordings`: replaced the old candidate
  dev server with the final live production preview at the same test origin.
  Two existing recordings reopened. The audio fixture played with
  `paused=false`, `readyState=4`, no media error and advancing `currentTime`.
  Saved a Unicode note, waited for Saved, reloaded and reopened the same note
  and audio. The unrelated missing-audio deletion fixture stays untouched.
  The separate live dev origin `http://127.0.0.1:1420/` also opened fresh.
- OPFS evidence at `http://127.0.0.1:5251/`: the final source launcher passed
  all 18 real-browser checks, including exact bytes, distinct names, two-context
  create/replace races, stable acquired Blob, history, explicit incoming
  recovery, wrong-directory refusal, canonical editor and close fence.
  The separate reload check passed; another complete run also passed 18/18.
  This named disposable demo removes only the folders it creates.

Screenshots: [Vocab words](../../../../apps/vocab/evidence/opfs-clean-break.png),
[Vocab chat](../../../../apps/vocab/evidence/opfs-clean-break-chat.png),
[Whispering](../../../../apps/whispering/evidence/opfs-clean-break.png),
[OPFS demo](clean-break-browser.png), and Zhongwen's
`docs/evidence/opfs-clean-break.png` in its own repository.

IndexedDB-unavailable opening is established by the automated throwing-global
checks and emitted bundle checks, not by these browser observations. Real quota
failure, disk flush, browser account selection, native Tauri, new microphone
capture and provider inference remain unverified. No IndexedDB database was
deleted.

## Integration and commits

Worker artifacts were integrated using task-start content hashes. Unrelated
preexisting dirt and prototypes are preserved. A fresh HEAD plus staged-patch
candidate exposed four existing prerequisite caller fixes in the bundle entries
and shared-folder workflow. Their full-file review and 87-assertion disk demo
are recorded by the Folder owner. These four paths are included explicitly;
they are not attributed to the clean-break implementation worker. Folder API removal and direct
consumer fixture/error changes form one coherent Epicenter commit because
splitting them would leave broken consumers between commits. Zhongwen is a
separate repository commit. Only task-owned paths and the three lock dependency
removals plus one ADR index row are staged; unrelated lock/index edits remain.

The clean staged candidate installs with its committed frozen locks and passes
Folder typecheck, 18 identity/bundle tests, the 87-assertion shared-folder demo,
Vocab's 97 tests, Whispering's 444 tests, Todos incoming and three platform
graph suites, and Vocab/Whispering types and production builds. It does not copy
unrelated dirty source or borrow live dependency links. No remaining grounded
blocker was found in the accepted clean-break scope; this is not a claim that
all conceivable flaws have been eliminated.
