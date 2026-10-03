```text
app-schema-derive-export-import/
|-- AGENTS.md
|-- package.json
|-- .agents/skills/
|   |-- computer-use-driven-iteration/SKILL.md
|   |-- delegate-claude/SKILL.md
|   |-- consult-claude/scripts/consult-claude.ts
|   |-- post-implementation-review/SKILL.md
|   `-- svelte/SKILL.md
|-- apps/todos/
|   |-- README.md
|   |-- package.json
|   |-- server/git-server.ts
|   `-- src/
|       |-- lib/{status.ts,status.test.ts,todos.svelte.ts,todos.test.ts}
|       `-- routes/components/AppHeader.svelte
|-- docs/adr/
|   |-- README.md
|   `-- 0474-incoming-file-folder-sync-is-an-explicit-clean-fast-forward.md
`-- packages/
    |-- folder/
    |   |-- README.md
    |   |-- package.json
    |   |-- node_modules/isomorphic-git/{index.js,index.d.ts}
    |   |-- evidence/kv-merge-iteration/
    |   |   |-- README.md
    |   |   |-- {source-fingerprint,integrated-source-fingerprint}.json
    |   |   |-- {diverged-baseline,merged-browser,conflict-browser}.jpg
    |   |   |-- native-publication-proof.rs
    |   |   `-- {native-index-review,empty-root-review}.ts
    |   `-- src/
    |       |-- {contract,folder,browser-store,tauri-adapter}.ts
    |       |-- {merge,tauri,files}.test.ts
    |       |-- {errors,paths,boundary,capture,bun,terminal,native-store,kv-merge}.ts
    |       `-- git/
    |           |-- {backend,browser-backend,native-backend,captured-index}.ts
    |           |-- {history,merge,errors,attributes,objects,browser-fs,runner,scope}.ts
    |           `-- {attributes,history,history-attempt,history-ordering}.test.ts
    `-- tauri-plugin-epicenter-folder/
        |-- Cargo.toml
        `-- core/
            |-- Cargo.toml
            `-- src/{git,owner,history,history_tests,lib,testing}.rs
```

# Review of the integrated browser merge wave

Keep the browser candidate/publication design, but correct two reproduced gaps before committing this wave. Native merging should remain unsupported until publication recovery and candidate isolation are demonstrated.

This is a findings-first review. No production changes were made after the request to report proposals before implementing them. The tree records files read across this wave and its review, including caller context and targeted sections of larger files. It does not claim a whole-repository audit. The source fingerprint identifies task-owned changes within a shared dirty checkout.

## Required corrections

### P1: captured-index validation regresses Bun fast-forward with a valid version 4 index

`src/git/history.ts:709` captures index bytes, then asks the backend to compare those bytes to the pinned head. `src/git/native-backend.ts:310` delegates this captured check to `captured-index.ts`, which uses isomorphic-git. The installed parser accepts only index version 2. Native Git accepts the version 4 index used by the reproduction.

The retained `native-index-review.ts` creates a disposable repository, selects index version 4, and invokes the actual Bun backend and history coordinator. Native cleanliness returns true; `pullFastForward()` returns `Failed` with `Unsupported dircache version: 4`. Codex reran the retained probe successfully. This affects the Bun directory backend; the Tauri Rust owner still uses its own native checks.

The captured-byte invariant is necessary: the preceding regression demonstrated that a staged value could otherwise be overwritten between the cleanliness check and index capture. Preserve that invariant, but let each backend interpret its own index. Browser validation can use isomorphic-git. Bun should validate a private captured index with native Git against the pinned head.

Consider replacing the separate `readIndex` and optional captured argument with one backend operation that captures bytes and validates them against the supplied head. That makes ownership explicit and avoids a method whose engine changes according to whether an argument is supplied. The deciding regression is a clean version 4 index completing fast-forward while the staged-index race continues to refuse publication.

### P2: flattening loses an empty root tree when checking KV eligibility

`src/git/merge.ts:150` obtains root KV entries from flattened file maps. The eligibility guard at line 157 checks modes and descendant paths. An empty Git tree named `kv.json` has neither a file entry nor descendants, so the guard treats it as absence.

The retained `empty-root-review.ts` constructs that exact base tree. Both sides replace it with different JSON mappings. `prepareMerge()` returns `merged`, although the intended semantic boundary accepts only an absent root entry or a plain `100644` blob in each of base, ours, and theirs. Codex reran the retained probe successfully.

This demonstrates an eligibility gap, not lost live data. Both descendant histories explicitly replaced the empty directory. Inspect the actual root tree entry for all three commits before semantic KV resolution. Reuse those entries when replacing the root blob; this can remove the descendant-prefix approximation. Add the empty-tree regression alongside existing mode and shape coverage.

## Boundaries that earn their place

Candidate preparation and live publication have different owners. Candidate preparation creates immutable objects without changing live files, index, or refs. Browser publication checks the complete file baseline and captured index, then publishes files, index, and branch in one IndexedDB transaction. Keep that boundary and the shared `publishIncoming` operation for fast-forward and merge.

Keep exact root-entry replacement, strict text eligibility, merge-attribute refusal, original merge parents, and structured conflicts. Ordinary two-sided byte merging can corrupt invalid UTF-8 through isomorphic-git; the demonstrated eligibility checks protect against that behavior. One-sided and identical arbitrary blobs retain their bytes.

Keep `mergeIncoming()` separate from `pullFastForward()`. The UI now offers an explicit action for divergence. A capability reason allows unsupported native adapters to explain the refusal. Raw conflicts preserve the values needed for a future choice. Whole root values remain atomic, so related fields can travel together without an unvalidated recursive combination. Application schema validation remains separate from Git history resolution.

The shared attribute evaluator has two consumers and owns real Git attribute semantics. The incoming-operation coordinator owns admission, close behavior, and attempt state. Neither is merely a forwarding wrapper. The Todos fetch-then-adopt sequences remain readable; a higher-order helper would add little at two callers.

## Small cleanup proposals

`mergeBases` is a one-caller forwarding wrapper without an invariant. Inline it or place the underlying call directly within candidate preparation. `ROOT_KV` and `PreparedMerge` need not be exported if they remain module-local.

The `PullError.Diverged` wording says the folder only applies fast-forwards. Browser folders now support explicit merging; the message should describe the pull operation. ADR 0474 also needs to reflect the new explicit clean-merge action while preserving the fast-forward pull contract. No package move or larger file reorganization is justified by this review.

## Acceptance and remaining gates

Codex reproduced 542 passing folder tests, with 15 native bridge tests skipped; 78 Todos tests passed. Folder typecheck and both Todos Svelte targets plus script typecheck passed. These results precede the two additional probes, which expose missing coverage despite the passing suites.

Actual Todos UI use combined independent root keys, survived reload, and produced a merge commit with exactly the original local and fetched parents. The action did not push. A later explicit loopback push succeeded. Competing changes to the same key stopped with the exact values and retained the local file and commit. The screenshots and README record those journeys.

Native publication remains an independent blocker. The scratch core proof held the index lock, observed incoming files land while HEAD stayed old, then demonstrated an ordinary commit recording those bytes without fetched ancestry. Native merging needs durable candidate and parent state, prevention of ordinary checkpoints during pending recovery, and failure/restart/ref-movement tests. Native candidate preparation also needs isolation from configured external merge drivers.

A conflict-choice UI is still unfinished. It should apply a choice against pinned base/local/incoming identities and revalidate before publication. Silent later-wins behavior is not implied by the current refusal UI. Typing during merging and switching editor selection remain direct UI acceptance gaps; automated saved-file baseline checks do not establish unsaved-editor behavior. Multiple or absent merge bases remain deliberately unsupported. Unreachable candidate objects currently have no browser garbage collection.

The next bounded wave should fix the two reproduced guards, retain the staged-index regression, and rerun affected checks. Native recovery and the conflict selector are separate work, rather than reasons to enlarge that correction wave.
