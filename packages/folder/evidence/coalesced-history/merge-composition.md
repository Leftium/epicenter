# Automatic history beside unfinished merges

The browser/Bun merge implementation preserves the automatic scheduler's
ownership: storage authorizes a request after a completed save; history
consumes it under Git protection; the repository owns durable incoming and
unfinished merge state. A blocked attempt does not capture files, push, or
retry when a person clears the blocker. A newer completed save can request a
new checkpoint.

## Corrected acceptance on October 5, 2026

Codex froze the corrected browser/Bun snapshot from
`/tmp/git-browser-accepted-20261005/packages/folder/src` over the earlier frozen
merge fixture. The fixture includes source dependencies and the Bun file
exchange addon. Dependencies resolve through the installed isolated clone.
No source under review changes during these checks.

Four executable probes passed, with 37 assertions:

- An automatic peer save waiting behind manual conflict publication becomes
  blocked, with zero captures and pushes. The original branch and three
  unmerged stages remain.
- Failed `MERGE_HEAD` publication leaves a pending incoming journal. The
  automatic request becomes blocked without capture or push. Explicit
  recovery completes publication without retrying the consumed request.
- A protected branch move after resolution and staging makes `commitStaged`
  return `BranchMoved`. The full private Git dump, staged resolution, and
  recorded merge remain unchanged. Restoring the original head allows a
  commit with the two original parents.
- An `ORIG_HEAD` directory makes Bun conflict publication return `Refused`
  before it writes authored files or the index. The branch stays unchanged;
  a later whole-folder commit returns `unchanged`.

The combined unfinished-merge, history-attempt, history-ordering, and
source-exclusion suites passed all 80 tests and 688 assertions. This includes
the staged peer admission regression: an incoming update that stops while a
staged commit waits returns `IncomingPending`, writes no Git state, and remains
recoverable. It also includes the complete automatic peer journey: blocked
requests do not restart after the manual merge; a newer save checkpoints the
saved files.

Commands run in the frozen corrected fixture:

```sh
bun test merge-ownership.test.ts
bun test --isolate fixture/src/merge-unfinished.test.ts \
  fixture/src/merge-unfinished-native.test.ts \
  fixture/src/git/history-attempt.test.ts \
  fixture/src/git/history-ordering.test.ts \
  fixture/src/source-scope.test.ts
```

Runnable probes, raw logs, and all fixture source hashes are retained at
`/tmp/epicenter-coalesced-20261005/corrected-acceptance/`. The original defect
probes are separately retained in `acceptance-probes/`; their two defect tests
assert the old behavior and are not acceptance tests for corrected source.

The original staged-journal branch-corruption claim was disproved:
`commitIndex` already refused the journal under protection. Moving the pending
check into staged admission fixes its error contract and protects earlier
cleanup, rather than repairing a demonstrated branch mutation.

## Review and integration

The existing independent Codex reviewer accepted the corrected browser/Bun
snapshot after a focused source follow-up. Merge completion pins both recorded
parents and uses compare-and-swap; cleanup requires the branch tip to have
exactly those parents. Bun records merge metadata before authored changes,
and orphan stages independently block whole-folder capture. Staged admission
rereads pending publication and blockers inside exclusive protection.
Repository state owns the merge; no app-owned merge registry is needed.

The Git testbed thread integrated the reviewed implementation and peer
regressions in `b217b0b699` (`feat(folder): preserve unfinished browser and
directory merges`). That thread separately reported 146 Git regressions,
seven app tests, and app typechecking passing. The 80-test fixture result and
four corrected probes above were independently reproduced by this coordinator.

Files read for the focused follow-up:

```text
packages/folder/src/
|-- merge-unfinished.test.ts
|-- merge-unfinished-native.test.ts
`-- git/
    |-- backend.ts
    |-- browser-backend.ts
    |-- history.ts
    |-- index-file.ts
    |-- merge-markers.ts
    |-- native-backend.ts
    |-- native-checkpoint.ts
    `-- opfs-git.ts
```

## Source identity

All ten corrected snapshot files matched the live checkout before integration
was committed. SHA-256 identifies the exact corrected inputs independently of
the checkout's extensive unrelated edits:

| Path under `packages/folder/src` | SHA-256 |
| --- | --- |
| `git/backend.ts` | `36f0492789c279e891b321d5a86b9304e4eb297b113c7460c328ebda736d3420` |
| `git/browser-backend.ts` | `262eb07753d7db88738fff98b76d11a1a350bd1743d0ec49e133e0293bef6088` |
| `git/history.ts` | `fef0b371cf158fe15843dce740d2867a5992b4711eb7d899dffedbac4e40fdf5` |
| `git/index-file.ts` | `dfa5857a43d1c228140a1a9426e9a41b4b1b7418881e1f30494cc803ef90edcf` |
| `git/merge-markers.ts` | `35222d028717d5a2e34e5de87ff8b7be78921f675bd14b50557e05abd22ec39f` |
| `git/native-backend.ts` | `0c8d7f0b8ff04e81ee3d4f1471e559254fbd70113e352649494ceebd4b7803ef` |
| `git/native-checkpoint.ts` | `8b7dff78496d7f325d129071594c5c9e516b892d7631abed7c932c45a8cb3676` |
| `git/opfs-git.ts` | `71995aedcf19ad2d6a2a554a5ae4efd4167e730c9372b5d27af4cefb0ad72f56` |
| `merge-unfinished-native.test.ts` | `a1c142b8ceedf24ee2c9c3d7ec7d3f044432ae0785d2a186238783a5b5852b5f` |
| `merge-unfinished.test.ts` | `58f14849e8d8028d0a79fab7a206f2fc56e3d6055b33bf1fac396db3116577b6` |

## Limits

These checks cover browser OPFS and the Bun directory backend. Native Rust
merge acceptance belongs to the Git testbed implementation thread. They do
not establish a new Bun journal for ordinary fast-forward publication; that
existing platform limitation remains separate from the new durable unfinished
merge barrier.
