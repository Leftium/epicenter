# KV merge iteration: browser baseline

## Outcome

Let independent root-key edits combine through repository synchronization,
while competing changes remain explicit and local saves survive a refusal.
This pass exercised the current UI before changing synchronization policy.

## Baseline and disposable data

- The pure TypeScript/Rust mergers were committed in `7a5315c822`.
- The Todos demo ran from the live checkout, at HEAD `10a41d1d25`, with
  unrelated uncommitted work present. Vite served current source, not a
  production bundle. No production code was changed during this pass.
- UI: `http://127.0.0.1:5224/`, a fresh browser origin and IndexedDB folder.
- Git backend: `http://127.0.0.1:5225/git/todos.git`.
- Disposable server root:
  `/var/folders/qx/9462vg517cvdtpjr4tt32_200000gn/T/epicenter-todos-Ow69kH`.
- Native counterpart: `native/` under that root, with bare remote
  `repos/todos.git`. All pushes in this pass went to this loopback remote.
- `source-fingerprint.json` records relevant source hashes after the journey.
  The checkout was shared with other work; this is not an isolated build.

## Journey and observed behavior

1. Create `kv.json` through the file browser and enter
   `{ "theme": "light", "language": "en" }` in its raw editor.
2. Wait for the editor to show saved data and the automatic local commit.
   Press **Commit and push**. The UI reported up to date. The common commit
   was `faa0b33`.
3. Pull the common history into the disposable native checkout. Change
   `language` to `zh`, commit as `2990622`, and push to the loopback remote.
4. In the browser editor, independently change `theme` to `dark`.
   Automatic local history recorded `c6628bd`; the browser retained
   `language: en`.
5. Press **Pull**. The UI reported **Pull stopped**, then
   **Diverged · 1 not pushed, 1 incoming**. Its guidance said to resolve
   the histories before pushing. No merge action was available in the
   status details.
6. Reload, reopen `kv.json`, and inspect the status details. Saved local
   values remained `theme: dark` and `language: en`. The histories still
   showed both commits. `diverged-baseline.jpg` captures this state.

This is the documented fast-forward-only behavior, not a regression in the
new merger. The UI has not invoked the new merger.

## Separate algorithm check

Read the exact common and remote `kv.json` blobs from the disposable native
repository. Supply the browser text shown above as ours. `mergeKv` returned:

```json
{
  "language": "zh",
  "theme": "dark"
}
```

This demonstrates the pure decision for the observed data. It does not
demonstrate repository publication or native UI merging.

## Next deciding checks

The UI choice is whether to add an explicit **Merge incoming changes** action
or let **Pull** attempt merges. The current recommendation is an explicit
action that preserves `pullFastForward`'s contract. The user has been asked;
no answer has been assumed.

Before implementing either action, settle repository candidate preparation.
The installed isomorphic-git 1.38.5 passes only the basename to `mergeDriver`,
so routing solely on `path === 'kv.json'` would also select nested files.
Delete/modify decisions can bypass the callback. Native and browser
integration must preserve full-path selection and whole-file conflict rules.

## Candidate preparation experiment

A read-only consultation proposed resolving root KV first, then writing two
temporary commits whose trees both contain the resolved root file. Git merges
those commits with ordinary rules. The real candidate commit uses that result
tree and the original local and remote commits as parents. Temporary commits
remain unreachable from live refs. This could remove both merge-driver adapters
and their path-dispatch/configuration machinery.

A transient Bun experiment used disposable repositories with native Git
2.50.1 and installed isomorphic-git 1.38.5. It exercised two cases:

| Case | Native Git | isomorphic-git | Live state |
| --- | --- | --- | --- |
| Independent root KV edits plus separate ordinary-file additions | Merged | Merged with identical tree OID | Files, index bytes, HEAD and all refs unchanged |
| Competing single-line edits to `archive/kv.json`, beside independent root KV edits | Conflict | Conflict | Files, index bytes, HEAD and all refs unchanged |

The real candidate commit in the successful case had the original local and
remote parents, and its KV blob matched the pure merger's output. The temporary
repositories were removed. This tested candidate preparation with filesystem
adapters, not the browser's IndexedDB adapter or publication into a live folder.

Before adopting this direction, challenge native partial publication: files
can land before an index or branch update fails. A later automatic commit could
record merged bytes without the second parent. Current fast-forward publication
is not evidence that this ancestry failure is handled. Multiple merge bases,
root-file deletion/addition, and configured native merge attributes also need
focused checks. The candidate approach remains a tested proposal.

Further disposable experiments established:

- Root KV add/add and deletion against unchanged root KV both produced identical
  native and isomorphic-git candidate trees, with refs unchanged. The deletion
  case retained an independent ordinary-file addition from the other side.
- Native `merge-tree` executed a configured `merge.probe.driver` selected by
  `*.txt merge=probe`. The harmless probe wrote a marker inside the temporary
  repository. Command flags alone therefore do not enforce zero live writes.
- A two-sided ordinary text-file merge whose first byte was `0xff` succeeded
  in both engines. Native preserved `0xff`; isomorphic-git replaced it with
  `0xef 0xbf 0xbd` (UTF-8 replacement character). Candidate preparation needs
  an eligibility rule before two-sided ordinary content merging. One-sided
  and identical arbitrary blobs should retain their exact bytes.

## Review judgment and next wave

Independent Codex and Claude reviews support the temporary-tree approach. They
disagreed about native publication after a partial failure. Claude argued that
a later local checkpoint and merge retry could restore the missing second
parent; Codex noted that this requires recovery and that ordinary line-merge
retries are unproven. No failure-injection test settled that claim in this pass.
Publisher reuse remains conditional on such tests, rather than on agreement.

The reviews also raised full-baseline validation in the browser transaction:
changed-path guards alone may not cover a concurrent save to an unchanged
tracked file. This was a source-review concern, not a reproduced UI failure.

The smallest next implementation wave is internal candidate preparation:
exact root-entry replacement without flattening modes or clobbering a root
directory, a single supported merge base, byte eligibility, native driver
isolation or refusal, original parents, and no live writes. Publication then
needs checks for stale later paths, unchanged-path saves, index failure, branch
movement, and recovery after partial application. Keep the existing UI behavior
until those checks establish the supported contract.

Consultation continuity: Claude session
`df321623-fb41-4320-a241-38fa9613f54e`; Codex review task
`candidate_merge_review`. Neither reviewer edited production source. This pass
added only evidence files. The disposable demo remains running for continuation.

The next acceptance journey should combine the two independent keys through
the app, then reload and inspect the saved result and merge ancestry. Adjacent
checks are same-key conflict, a save during candidate preparation, and a nested
`archive/kv.json` that must use ordinary file rules. Conflict and stale-save
refusals must preserve live files, index, and branch refs.

Native UI acceptance remains open. Recurring runs have not been scheduled;
the user has been asked whether iteration means rounds in this chat or
scheduled follow-ups.

## Native publication failure demonstrated

A focused test against a disposable copy of the current native core held
`.git/index.lock` after fetching a fast-forward. The owner returned
`PullError::IndexFailed`, with incoming file bytes already applied and HEAD
still on the original commit. After releasing the lock, an explicit ordinary
checkpoint committed those bytes with only the original parent. Its commit
was not the fetched commit. This confirms the ancestry concern; retrying
is not an established publication guarantee.

`native-publication-proof.rs` retains the test, which is appended to the
core's `history_tests` module in the disposable copy. The copy used the
repository's Specta Git patches and absolute fixture include paths.
`cargo test --offline --manifest-path
/tmp/epicenter-native-publication-proof-20261003/Cargo.toml
kv_iteration_an_index_failure -- --nocapture` passed: one test, 73 filtered.
The live native implementation was not changed by this experiment.

Native merge publication must retain the intended candidate and parents
durably before applying files, block ordinary checkpoints while recovery is
pending, and verify recovery after index failure, ref movement, interrupted
application, and restart. Browser merge support can proceed independently
with one IndexedDB transaction for files, index, and branch. Native merge
remains unsupported until that recovery contract is implemented and tested.

## Integrated browser wave, 2026-10-03

The user's follow-up authorized the explicit merge action. Claude implemented
the browser coordinator and Todos action in an independent clone. Codex
integrated only the difference from the transferred source snapshot; live
files were checked against that snapshot before each replacement. Unrelated
shared-checkout edits were preserved. Worker session:
`7957e9c1-d044-4753-b601-a63ff24ba59a`.

Codex then demonstrated and corrected an index race: a staged KV value,
followed by restoring the working file, could be overwritten when staging
landed between the clean-index check and the later index capture. The new
regression failed with `Expected Err, but got Ok` before the correction and
passes afterward. The check now examines the captured index against the
pinned head, and publication compares those same bytes.

The loopback services were restarted on the same ports and disposable root.
Through the actual Todos UI, **Merge incoming changes** combined browser
`theme: dark, language: en` with incoming `theme: light, language: zh`.
It saved `theme: dark, language: zh`, with no uncommitted changes. The merge
commit is `7d3f318fa402dd2231ee966971437d2c441875d7`; its parents, verified with
plain Git after pushing to the loopback remote, are exactly
`c6628bd851fb5c968a0294a712df939562216829` and
`2990622a2d93ea59278eb3e8a1c43aeaef5ef9a7`. Reload retained the merged values.
The action did not push; a later explicit **Commit and push** succeeded.
`merged-browser.jpg` captures the result before that push.

Next, the native fixture changed `theme` to `amber` and pushed `bb1cbb3`.
The browser saved `theme: blue` as `26152d5`. Pull fetched and stopped as
diverged. Merge stopped with the exact key and both values, preserving the
local blue value and the local commit. `conflict-browser.jpg` captures that
refusal. These are disposable UI data; no production remote was used.

Codex reproduced the checks in the live checkout:

- Folder tests: 542 pass, 15 native bridge tests skipped, zero failures.
- Todos tests: 78 pass, zero failures.
- Folder typecheck passes. Both Todos Svelte builds and script typecheck pass.
- Native failure proof: one scratch core test passes, as recorded above.

The passing suites do not close all acceptance. A fresh read-only structural
review subsequently reproduced two missing cases: the Bun directory backend
rejects a valid version 4 index through the new captured-index parser, and
root-KV eligibility loses an empty Git tree in the merge base. See `review.md`.
The subsequent user request commits this wave as a checkpoint with those two findings still open. The passing suites do not establish that these guards are correct.

`integrated-source-fingerprint.json` records the exercised task source. Vite
served the live shared checkout, so this is not an isolated production build.
The browser remains on the same-key conflict for the next interaction.
Native merge publication, native candidate isolation, and a UI conflict
selector remain unfinished. No recurring automation was scheduled.
