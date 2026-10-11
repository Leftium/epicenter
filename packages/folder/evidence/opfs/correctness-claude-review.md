**Verdict: adopt both changes.** I found no Critical, High or Medium correctness problems in this scope. There are two Low findings and three informational notes, all listed below. I didn't edit anything and didn't launch child agents.

## Files read

```
/private/tmp/opfs-correctness-worker-epicenter-20261005
+-- review-packet.md                                   FULL
+-- review-folder.diff                                 FULL
+-- review-zhongwen.diff                               FULL
+-- regression-mutations.json                          FULL
+-- folder-regression-without-fix.log                  FULL
+-- folder-regression-restored.log                     FULL
+-- zhongwen-regression-without-fix.log                FULL
+-- zhongwen-regression-restored.log                   FULL
+-- packages/folder/
|   +-- evidence/opfs/main.ts                          EXCERPT 190-240, 440-543
|   +-- evidence/opfs/peer.ts                          FULL
|   +-- src/publication.test.ts                        FULL (untracked)
|   +-- src/storage.ts                                 FULL
|   +-- src/errors.ts                                  FULL
|   +-- src/opfs-store.ts                              EXCERPT 520-879
|   +-- src/browser-adapter.ts                         EXCERPT 250-398
|   +-- src/bun.ts                                     EXCERPT 60-110
|   +-- src/native-store.ts                            EXCERPT 150-315, 360-470 (+grep)
|   +-- src/tauri-adapter.ts                           EXCERPT 150-230 (+grep)
|   +-- src/terminal.ts                                EXCERPT 120-239
|   +-- src/git/history.ts                             EXCERPT 900-954, 1340-1389
|   +-- src/editor.ts                                  EXCERPT 335-394
|   +-- src/table.ts                                   EXCERPT 365-394
|   +-- src/folder.ts                                  EXCERPT (grep) 180-228
|   +-- src/browser-storage.test-support.ts            EXCERPT (grep) 40-179
+-- review-zhongwen/src/
|   +-- lib/learner.ts                                 EXCERPT 150-279
|   +-- lib/learner.test.ts                            EXCERPT 1-230
|   +-- lib/test-support.ts                            FULL
|   +-- lib/opfs.test-support.ts                       EXCERPT (grep: faults/close)
|   +-- lib/vocabulary.ts                              EXCERPT (grep) 61-127
|   +-- routes/+page.svelte                            EXCERPT 78-127, 200-260
|   +-- lib/api.ts, components/PhraseCapture.svelte    GREP ONLY (addEntries callers)
NOT OPENED: contract.ts (listed in the packet; no Partial/hint logic reached it in my traces),
            review-baseline/* (I relied on the cumulative diffs instead)
```

## Starting from the callers: what has to hold

**Folder hints.** There are two producers of hints:
- The OPFS boundary tells **other tabs** about each step as it lands. It already counts an `Unconfirmed` step as landed (`opfs-store.ts:651-653`, and `:645` for a move's destination).
- `withPublication` tells **this handle's listeners** when the save finishes, by working backwards from the receipt (`storage.ts:43-66`).

Before the candidate, a `Partial` result told local listeners only about `applied` steps. So a step whose outcome was unknown inside a batch was announced to other tabs but not to this one. The editor (`editor.ts:350-351`) and table watchers on this handle would keep stale state. The mutation log shows this directly: `folder-regression-without-fix.log:13-18`, where `destination/b.md` is missing from what was heard.

The candidate fixes this at `storage.ts:54-59`. It applies the same rule the boundary relay uses (`stepError.name === 'Unconfirmed'`) and the same shape as Git's incoming `unconfirmed` handling (`history.ts:939-948`, which hints applied steps plus uncertain paths). So all three emitters now use one classification, owned by whoever produced the error. That is the right owner. The native store (Bun) never produces `Unconfirmed` (`native-store.ts:174-310`), so in practice this change only affects OPFS. Tauri gets its hints from the desktop owner (`tauri-adapter.ts:1021-1023`), so it's out of scope.

**Zhongwen.** Row IDs are random, so calling `create` again for the same text after an unknown outcome writes a second file. The without-fix log shows this: `actual: ["顺便","难怪"]` (`zhongwen-regression-without-fix.log:23`). The candidate keeps one `attempted` set per call (`learner.ts:242-250`). It removes `saved.add` (the old `saved.add(text)` line 259), because `attempted` already covers both success and failure. That's one rule instead of two.

## Greenfield alternatives

| Option | What it deletes | What it costs | Decision |
|---|---|---|---|
| **The candidate**: hints = applied ∪ the failed step only if its outcome is unknown | — | +7 lines and one conditional (`storage.ts:52-59`) | **Adopt** |
| A. Always hint the failed step on `Partial` | 3 lines (the ternary) | Over-hints failures known to have changed nothing. Breaks the "confirmed prefix only" test and drifts from both the relay rule and the Git precedent. Rereads are harmless, so the cost is consistency, not safety. | Reject |
| B. Collect the boundary's per-step `landed` calls for each apply and replay them locally (one source for this tab and other tabs) | Rebuilding `stepPaths` in `withPublication` (~10 lines) | Needs a per-call `landed` channel on the internal `FolderStorage.apply`. Moves work onto `native-store`, which has no `landed` callback, and the Git store. The terminal still needs the receipt. | Proposal only |
| C. Zhongwen: give rows a deterministic ID derived from the text, so `Exists` removes duplicates | The `attempted` set, possibly `oneAtATime` | Needs a migration of rows with random IDs, makes arbitrary text part of the path, and changes what renames mean. Not allowed under the constraints. | Proposal only |
| D. Zhongwen: rescan after an `Unconfirmed` result inside the call | — | Turns "unknown" into a claim that it landed, which the code says bytes can't prove (`opfs-store.ts:569-571`). Adds I/O. | Reject: breaks "unknown stays unknown" |

What the change keeps intact:
- The receipt is returned unchanged (`publication.test.ts:117`).
- `Partial` still calls `noteEdit` exactly once and never `requestAutomaticCommit` (`:118-119`).
- The success branch, the full-`Unconfirmed` branch, the relay to other tabs and the `pageOrder` superseded fence are untouched.
- Unchanged: `applyOne` (admitted-write semantics), how a folder's address/identity is captured, Git incoming recovery and audio byte acquisition.

## Correctness findings

1. **Low: Zhongwen can list the same text as both `skipped` and `failed`.** See `learner.ts:244-246` and the test's assertion at `learner.test.ts:136-137`.
   - The type comment allows it ("repeated within the request", `vocabulary.ts:66`).
   - But the page's text would say "Skipped N **already in your list**" (`+page.svelte:205-208`), which is false when the first attempt was refused.
   - The current UI can't reach this: `reviewAdditions` removes repeats first (`vocabulary.ts:115-118`) and `PhraseCapture` sends one text.
   - No change is needed now. If a future caller sends raw repeats, revisit the copy (that's a UI change, out of scope).

2. **Low (evidence gap): the reader check still accepts read failures it can't classify.** See `peer.ts:78` and `main.ts:522-532`.
   - The candidate correctly rejects a failed peer reply and zero successful reads.
   - But a `NotFound` during an overwrite would be neither old nor new bytes. It passes as long as one read succeeds, because the peer only reports a count.
   - Optional fix, limited to the evidence files: have the peer report the error names and assert they're all within the expected set (e.g. `Io` from a stale `File`).

3. **Info: for a failed OPFS move, this tab hears `from` and `to`, other tabs hear only `to`.** Compare `storage.ts:56-58` with `opfs-store.ts:653`. The wider local hint is principled: the layer above the backend can't assume the move happened in two steps. But the test pins the extra `source/b.md` (`publication.test.ts:39-44`) under a title that says "uncertain destination". A later narrowing would break this test on purpose; that's acceptable.

4. **Info: the Zhongwen logs came from a different clone.** The stack paths are `/private/tmp/opfs-correctness-worker-zhongwen-20261005/...`. The inner frames (`test-support.ts:198`, `learner.test.ts:180/200`) don't line up with the frozen snapshot, where `withFolder` calls `use` at line 106. The top frames do match (`:135:10`, `:161:10`), so this is probably source-map drift. It's still unverified.

5. **Info: no typecheck log or full candidate Folder suite run is in this checkout.** The packet says the typecheck was "being reproduced", and the 638/676 figures are for the baseline.

## Verification limits

- I traced code and read the logs; I ran nothing.
- All fault paths are in-memory (`opfs.test-support.ts` faults).
- The new reader predicate in `main.ts` hasn't been shown to run in a real browser. The 18/18 OPFS result is the baseline.
- I didn't check the Tauri owner's own handling of an unknown step inside a `Partial`. It's out of scope, but it's the place where the same gap could still exist.

## Checks that would decide it

1. Run the real-browser OPFS acceptance page with the candidate `main.ts`. "A reader in another context sees whole old or new bytes" should pass with `seen.length > 0`, and the failure count should be recorded.
2. Run the full candidate Folder suite and `typecheck`, and keep the raw logs.
3. Diff `review-zhongwen/` against `/private/tmp/opfs-correctness-worker-zhongwen-20261005` to confirm the frozen snapshot is the source that was tested.
4. Optional: make the peer return `ok: false` once and confirm `main.ts:523` turns the check red.