# Bounded correctness review

## Files read

`full` means all source was read, sometimes across several calls. `excerpt` means only the named portions or search results were read. Listings of filenames were used for navigation; no competing review was read.

```text
/Users/braden/Code/worktrees/epicenter/app-schema-derive-export-import/
`-- .agents/skills/
    |-- adversarial-review/SKILL.md                         [full]
    |-- post-implementation-review/SKILL.md                 [full]
    |-- rethink/
    |   |-- SKILL.md                                       [full]
    |   `-- references/radical-options.md                   [full]
    |-- testing/SKILL.md                                   [full]
    `-- monorepo/SKILL.md                                  [full]

/tmp/opfs-correctness-worker-epicenter-20261005/
|-- review-packet.md                                       [full]
|-- review-folder.diff                                     [full]
|-- review-zhongwen.diff                                   [full]
|-- regression-mutations.json                              [full]
|-- folder-regression-restored.log                         [full]
|-- folder-regression-without-fix.log                      [full]
|-- zhongwen-regression-restored.log                       [full]
|-- zhongwen-regression-without-fix.log                    [full]
|-- packages/folder/
|   |-- README.md                                         [excerpt: storage, handle, composition]
|   |-- package.json                                      [full]
|   |-- evidence/opfs/
|   |   |-- main.ts                                       [full]
|   |   `-- peer.ts                                       [full]
|   `-- src/
|       |-- storage.ts                                    [full]
|       |-- publication.test.ts                           [full]
|       |-- browser-adapter.ts                            [full]
|       |-- boundary.ts                                   [full]
|       |-- capture.ts                                    [full]
|       |-- contract.ts                                   [full]
|       |-- errors.ts                                     [full]
|       |-- folder.ts                                     [full]
|       |-- terminal.ts                                   [full]
|       |-- opfs-store.ts                                 [full]
|       |-- browser-storage.test-support.ts               [full]
|       |-- opfs.test-support.ts                          [excerpt: types, faults, writable behavior]
|       |-- table.ts                                      [excerpt: create and publication callsites]
|       |-- editor.ts                                     [excerpt: admission, submit, publication callsite]
|       |-- files.ts                                      [excerpt: applyOne callsites]
|       |-- kv.ts                                         [excerpt: applyOne callsite]
|       |-- bun.ts                                        [excerpt: publication and hint wiring]
|       `-- git/
|           |-- history.ts                                [excerpt: incoming outcomes, recovery, noteEdit, automatic commit]
|           `-- opfs-git.ts                               [excerpt: applyInOrder and uncertainty callsites]
|-- review-baseline/
|   |-- packages/folder/src/storage.ts                    [full]
|   |-- packages/folder/evidence/opfs/main.ts              [excerpt: peer reader check]
|   `-- zhongwen/learner.ts                               [excerpt: additions and following update contract]
`-- review-zhongwen/
    |-- README.md                                         [full]
    `-- src/
        |-- routes/+page.svelte                           [excerpt: loading, review, additions, outcome display]
        |-- routes/+layout.svelte                         [excerpt: search for affected callers; no matching lines]
        `-- lib/
            |-- learner.ts                                [full]
            |-- learner.test.ts                           [full]
            |-- test-support.ts                           [full]
            |-- opfs.test-support.ts                      [excerpt: types, faults, writable behavior]
            |-- vocabulary.ts                             [full]
            |-- definition.ts                             [full]
            |-- folder.ts                                 [full]
            |-- api.ts                                    [full]
            `-- components/PhraseCapture.svelte           [excerpt: scan and add caller]

/tmp/opfs-correctness-worker-zhongwen-20261005/
`-- src/lib/
    |-- learner.ts                                        [full byte comparison with frozen reviewed file]
    `-- learner.test.ts                                   [full byte comparison with frozen reviewed file]

/tmp/opfs-bounded-correctness-20261005/
|-- folder-assignment.md                                  [full]
|-- zhongwen-assignment.md                                [full]
|-- folder-candidate-types-final.log                      [full]
|-- opfs-candidate-build.log                              [full]
`-- baseline.json                                         [excerpt: baseline heads and preservation inventory]
```

## Recommendation

Accept the bounded candidate. I found no actionable correctness blocker in the changed behavior. The strongest design within the settled constraints converges on its ownership split: raw storage owns publication classification, `withPublication` owns local save accounting, and `addEntries` owns its invocation's input attempts. Retaining that split is a design judgment after considering a concrete alternative, not an inference from passing tests alone.

This is an independent read-only review. I launched no children, edited no candidate source, and did not inspect the complementary review. The implemented proposal was visible; this was not a blind preimplementation exercise. I started with the desired outcome, production contracts, actual terminal/addition callers, and raw storage before reading the cumulative diffs.

## Desired whole and actual use

A caller needs three facts kept separate:

1. Which input or file step has already been attempted.
2. Which paths may now need rereading.
3. Which writes have confirmed receipts.

An uncertain receipt must not authorize another random-ID creation in the same request, suppress a necessary reread, or request an automatic commit. Observing the submitted bytes afterward cannot retroactively establish which write published them.

The affected production batch caller is the terminal. Recursive removal and directory movement submit captured file steps together. The first move can succeed, the next destination stream can publish and lose its close reply, and the remaining move is never attempted. Browser raw storage relays the uncertain destination to other contexts as the step finishes; local observers are notified through publication accounting when the application returns. Thus the two notification paths have different owners and timing, while both remain hints.

```text
files / table / KV / editor / terminal
                  |
             close fence
                  |
       local publication accounting
          |                 |
      history stale      local hints
                  |
       raw OPFS plan and perform
          |                 |
     exact receipt      cross-context hints

Git incoming publication -> raw storage -> explicit incoming recovery
```

The diagram's split is load-bearing. Git must use raw storage, because an incoming tree is not a new authored save that should schedule a local commit. The unchanged Git path already distinguishes confirmed steps and uncertain paths in its incoming outcomes. Moving all accounting indiscriminately into raw storage would break that policy.

Zhongwen's actual paste caller reviews unique normalized strings before calling `api.addEntries`; phrase capture sends one string. The learner operation nevertheless has its own public responsibility for repeated normalized input, demonstrated directly by its tests and needed by other callers. Its cross-tab Web Lock owns scan-and-create. Its storage scan is fresh per invocation. The UI reads confirmed additions and failure messages from the outcome, then reloads saved entries; it does not reinterpret matching stored bytes as a successful receipt.

## Strongest compliant greenfield design

I would build a publication attempt with the same three bounded owners, rather than make storage promise batch atomicity or make the UI reconcile uncertain receipts:

- The raw publisher reports successful progress and the failed attempted step without rollback. It owns the close boundary and the distinction between `Io` and `Unconfirmed`.
- One shared local accounting wrapper computes the paths requiring reread from that report, invalidates history, and requests a commit only for a fully successful nonempty local application.
- The learner owns a short-lived set of attempted normalized inputs, populated before awaiting publication. It never persists that set or mistakes it for a saved-text index.

For `addEntries(folder, [' 顺便 ', '顺便', '难怪'])`, suppose the first creation lands but returns `Unconfirmed`. The first text enters `failed`, the repeated occurrence enters `skipped` without a second create, and the distinct text can enter `added`. On the next invocation, a fresh scan finds the landed row and skips its text. If the earlier attempt left no row, that new invocation may create it. If it left an unreadable empty row, the existing unknown-text refusal remains necessary: the next invocation cannot safely assume what expression that file represents.

The candidate implements this with `attempted` at `review-zhongwen/src/lib/learner.ts:242`, checks it at line 244, and reserves the text at line 250 before creation. Keeping `saved` separate costs one set and one membership check per input; it makes the evidence distinction explicit. Merging attempted inputs into a set named `saved` would remove a tiny amount of code while giving a false meaning to an unknown write. A renamed exclusion set would be workable in isolation, but the assignment explicitly requires tracking attempts independently, and there is no material deletion prize that justifies changing it.

The concrete deletion prize this design already realizes is the removal of success-only `saved.add(text)` from the publication loop, plus any need for readback-and-adoption, per-input automatic retries, a persistent deduplication index, or UI-level duplicate repair. The replacement guarantee is at most one create attempt per normalized input per invocation regardless of its receipt, with current storage determining the next invocation's eligibility. No responsibility is transferred to the learner beyond the existing explicit retry and repair actions.

## Strong alternative and why it loses here

The serious alternative is one raw publication effects record, emitted or accumulated by `perform`, containing confirmed and uncertain paths beside an untouched receipt. Local and remote observers would consume that record instead of reconstructing path effects independently from result variants.

```text
Current files                         Proposed ownership, same file tree
src/opfs-store.ts: raw step events     src/opfs-store.ts: effect record per attempt
src/storage.ts: receipt -> hints      src/storage.ts: effects -> hints; receipt -> commit
src/browser-adapter.ts: remote relay  src/browser-adapter.ts: local and remote effect consumers
```

Its prize is precise: delete local `Partial` and direct `Unconfirmed` path reconstruction and centralize the uncertain destination/source distinction at the step executor. That is a stronger single-owner guarantee when every storage producer participates. It would also avoid conservative source hints for a move whose destination close alone was uncertain.

Under these constraints, however, that destination is weaker overall. Applying it only to OPFS leaves Bun using receipt reconstruction and introduces two accounting mechanisms. Making it universal changes the internal storage producer contract and requires adapter/native participation beyond this frozen lane. Wiring local history into an early raw callback also introduces initialization and admission/reentrancy concerns: history is built using the raw boundary, listeners can synchronously close the handle, and local notifications currently occur after the application returns. A record accumulated and delivered at completion would need a new operation-owned envelope or collector, plus fallback shaping for non-OPFS producers. The candidate needs none of that new machinery.

No new file organization is warranted. The shared wrapper has two production opener callers and enforces a real policy boundary. The one-caller in-place evidence predicate is clearer than an exported helper. The new test file is cohesive around publication accounting and combines an actual terminal fault trace with direct receipt-preservation tests.

Other apparent simplifications lose required guarantees. Serializing public single-file calls to replace terminal batches discards the raw all-conditions-before-publication behavior and admits interleaving. Deterministic text-derived learner IDs would change durable addresses, importing/deletion behavior, and the requirement that readding a deleted expression creates a new identity. Treating matching readback bytes as confirmation loses receipt accuracy. Automatically replaying incoming Git work loses explicit recovery. None is a compliant replacement.

## Correctness audit

**Blockers: none found in the bounded candidate.**

The changed `Partial` branch at `packages/folder/src/storage.ts:50`:

- Always marks history stale.
- Announces every confirmed applied step.
- Announces the failed step only when its inner error is `Unconfirmed`.
- Never mentions `notAttempted`.
- Never requests an automatic commit.
- Returns the exact original result object at line 66.

The uncertain move is conservatively hinted at both endpoints because `FileStep.move` does not identify which substep became uncertain. For OPFS destination-close failure this can include an unchanged source; that is valid for a reread hint. Requiring exact changed paths would need the richer effects representation discussed above. An unattempted later path remains excluded.

In `opfs-store.ts`, a destination that was confirmed before source removal fails becomes an applied destination write plus a failed source remove. The wrapper therefore handles synthetic `Partial`/`Unconfirmed` source-removal reports without confusing them with destination failure. The actual OPFS remove helper currently translates thrown removals to `Io`; the synthetic source test proves accounting of an allowed result shape, not a real injected browser uncertain removal. The report must preserve that distinction.

`history.noteEdit()` only invalidates the observation; `requestAutomaticCommit()` is a separate method. The current fix calls only the former on partial or uncertain publication. A previously running commit or a later successful independent save may still observe the current tree. The guarantee is that this uncertain/partial receipt schedules no commit of its own, not that all history work globally stops.

The evidence check at `packages/folder/evidence/opfs/main.ts:522` rejects a failed peer reply before inspecting its optional fields, rejects zero successful states, and accepts any nonempty subset of the two whole-file hashes. It preserves failure counts. It makes no promise to observe both states or prove scheduling overlap. `peer.ts` records a hash only after a successful folder read; otherwise it increments failures.

Identity capture, page-order reservation, the close fence, acquired Blob bytes, and incoming recovery were unchanged. The touched code has no new public API, fallback representation, export, migration, or native behavior. The changed helper has not gained a hidden lifecycle. Existing storage and wrapper types own distinct contracts and earn their boundaries.

### Scope limitation

At `review-zhongwen/src/lib/learner.ts:251`, an unexpected rejected create promise still exits the loop, and `api.ts` turns that whole action into an unknown refusal, losing detailed earlier receipts and leaving later distinct inputs unattempted. The same uncaught await exists in the supplied baseline; this candidate does not introduce it. The raw assignment says distinct inputs proceed under the current contract, and the editor explicitly treats storage throws as bugs rather than Result outcomes. The coordinator confirmed during review that scope is the existing Folder Result contract, including `Unconfirmed`, and existing thrown behavior must remain. This is an explicit limit on the verdict, not a candidate blocker.

The review does not certify preservation of detailed per-item receipts after arbitrary thrown create actions. That would require a separate exception policy and a wider task.

## Verification

I ran these checks read-only against the frozen candidate:

- `bun test --isolate packages/folder/src/publication.test.ts`: 5 pass, 0 fail, 22 assertions.
- `bun run --filter @epicenter/folder typecheck`: exit 0.
- Full byte comparisons of frozen learner source/tests against `/tmp/opfs-correctness-worker-zhongwen-20261005/src/lib/`: identical.
- `bun test src/lib/learner.test.ts` in that matching Zhongwen clone: 15 pass, 0 fail.
- Executed the actual source block of the in-place peer predicate in a disposable Bun invocation: failed reply with known hash, empty successful reply, missing successful observations, and foreign hash rejected; old-only, new-only, and both known states accepted. The accepted mixed-state case included nonzero failed-read accounting. No production helper or file was introduced for this check.

I inspected the supplied mutation logs: reverting only Folder's production fix fails three of the five publication tests; restoring it passes all five. Reverting only the learner production fix fails the two new regressions; restoring it passes all fifteen learner tests. Those are supplied raw logs, not mutation experiments performed during this read-only review.

The packet's full-suite and browser claims remain supplied evidence. I did not rerun the whole monorepo, start a browser server, or claim real-browser injected failures. The candidate evidence build log shows a completed Vite build with externalized `node:zlib` and chunk-size warnings. My own Folder typecheck verifies the candidate after the dependency/inference repair described in the packet. No failure in my checks requires baseline attribution.

## Next deciding checks and handoff

The bounded destination has sufficient evidence for integration. Verify the integrated tracked source and task-owned test match the reviewed versions, then run the corrected real-browser evidence page against the integrated candidate. The packet's live baseline 18/18 observation establishes browser behavior of the baseline but does not itself execute the newly strengthened predicate; the candidate predicate was verified here with exact source execution and builds.

Keep the uncertain source-removal coverage described as synthetic receipt accounting. No new backend seam is justified solely to manufacture an OPFS uncertain remove. The actual terminal test and mutation evidence cover the production failure under repair.

Do not add the effects-envelope redesign, deterministic learner IDs, readback confirmation, or per-item arbitrary-throw recovery to this integration. A future broader publication redesign should prove the effects owner can serve OPFS, Bun, native transport, and Git policy without duplicating accounting or changing admitted-write behavior. Until that proof exists, the retained boundary is the stronger supported design.
