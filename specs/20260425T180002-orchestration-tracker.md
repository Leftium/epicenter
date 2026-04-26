# Document-primitive rollout — orchestration tracker

**Status**: active (PR-A merged 2026-04-26; PR-D / PR-E queued)

Live status for the multi-PR rollout. Update as work lands. This file gets deleted once PR-E ships per the post-merge convention.

**Plan revision (2026-04-25):** what was originally PR-B and PR-C have been folded into PR-A. The arc ends with the factory teardown; PR-A ships terminal state. PR-D and PR-E are unchanged.

**Plan revision (2026-04-25, late):** Phase 2's seven deletions executed *with one reversal*. Deletions 1, 2, 4, 5, 6, 7 landed verbatim. Deletion 3 (delete `openFuji()` wrappers) executed first then got reversed by the iso/env/client three-file split — see `specs/20260425T225350-app-workspace-folder-env-split.md` for the resolution and `docs/articles/workspaces-were-documents-all-along.md` v5 for the narrative. The contradiction between v3 ("delete the wrapper") and v5 ("un-delete the wrapper, but for a different reason — bleed prevention, not encapsulation") is the most durable artifact PR-A produced.

**Status update (2026-04-26):** PR-A merged at `252dced47`. Scaffolding files (PR body draft, Phase 1 + Phase 2 execution prompts) deleted in a follow-up cleanup PR per the convention landed during PR-A: durable artifacts (architecture specs, skills, articles) stay; scaffolding (PR body drafts, executed prompts, in-flight trackers) gets deleted once the work it scaffolds is complete. This tracker stays until PR-E lands.

---

## Roadmap

```
PR-A (terminal state of the refactor arc)
   │  Section 1: subprotocol auth + Result envelope
   │  Section 2: workspace primitive collapse — through factory teardown
   │  Section 3: CLI scripting-first redesign
   │
   │  Includes (was-PR-B): dispatch + getToken callbacks on attachSync,
   │                       drop ACTION_BRAND, drop requiresToken,
   │                       always-async-Result, delete RemoteReturn
   │  Includes (was-PR-C): drop Document, DocumentHandle,
   │                       createDocumentFactory, openFuji() wrappers,
   │                       ActionIndex, entry.handle envelope; rewrite
   │                       CLI loader; rename app workspace exports
   │                       to domain nouns; per-row content docs to
   │                       app-local cache
   │
   │  All three articles ship (workspaces-were-documents-all-along
   │  includes the v4 coda)
   │
   ▼
PR-D (awareness publishing)   ← spec: 20260425T000000-device-actions-via-awareness.md (Phase 1)
   │  scope: serializeActionManifest helper, invoke helper, awareness
   │         state convention, Fuji + playgrounds publish offers
   │  No new attach primitive
   │
   ▼
PR-E (CLI cross-device)       ← spec: 20260425T000000-device-actions-via-awareness.md (Phase 3)
   │  scope: epicenter devices command, dot-prefix run resolution
   │         (`epicenter run desktop-1.action.path`)
   │
   ▼
[future] First real cross-device action
   │  e.g. Claude Code remote, Whisper-on-Mac, open-tab-in-browser
   │  proves the awareness/invoke layer end-to-end
```

---

## Status

| PR | Status | Description location | Notes |
|---|---|---|---|
| PR-A | **MERGED 2026-04-26** (`252dced47`) | https://github.com/EpicenterHQ/epicenter/pull/1705 | 520 commits. Both phases landed; six of seven Deletion targets executed; Deletion 3 reversed mid-flight (iso/env/client split). PR body draft + execution prompts deleted post-merge. |
| PR-D | Architecture specced; implementation prompt pending | `specs/20260425T000000-device-actions-via-awareness.md` | Now ready to draft against real merged shapes in main. |
| PR-E | Architecture specced; implementation prompt pending | `specs/20260425T000000-device-actions-via-awareness.md` Phase 3 | Drafted after PR-D merges. |

---

## What to do, in order

### Step 1 (now, ~15 min): get Phase 1 onto the PR branch

Phase 1 commits live on `attach-sync-dispatch-revision`, eight commits past `braden-w/document-primitive` head. Push them up so PR-1705 reflects current state.

```bash
git push origin attach-sync-dispatch-revision:braden-w/document-primitive
```

The PR auto-updates. Live body still describes pre-Phase-1 state — that's fine; it gets fully rewritten at Step 4.

### Step 2 (~3-5 days): execute Phase 2 — DONE, with one reversal

Hand off `specs/20260425T180001-execution-prompt-phase-2-teardown.md` to an implementer (you, or an agent). The prompt is self-contained.

**Outcome**: 6/7 deletions landed verbatim. Deletion 3 (delete `openFuji()` wrappers) executed first then got reversed by a same-day decision — bundle bleed prevention required restoring the wrappers under an iso/env/client three-file split (`20260425T225350-app-workspace-folder-env-split.md`). The Phase 2 spec carries a gravestone marking that section superseded.

### Step 3 (~1 hour): add the v4 coda — DONE

`docs/articles/workspaces-were-documents-all-along.md` now carries v4 *and* v5 codas. v4 covers the framework teardown (`Document` / `DocumentHandle` / `createDocumentFactory` → `createDisposableCache`); v5 covers the wrapper restoration under the iso/env/client convention. The v3 → v5 contradiction is the article's strongest payload.

### Step 4 (~1-2 hours): finalize PR-A body and merge

1. Rewrite `specs/20260425T180000-pr-body-document-primitive.md`:
   - Drop the "What's coming next" entries for the now-folded Phase 1 and Phase 2 specs; keep PR-D and PR-E
   - Drop the trailing "trajectory" paragraph about the last five commits
   - Repick keystones from terminal-state commits — `3dec00926` (dispatch/getToken pivot) replaces `b2fd9e158` (setToken/requiresToken, now deleted); pick a Phase 2 keystone for the factory deletion
   - Update Section 1's action-return wording to reflect always-Result (no `RemoteReturn` conditional type)
   - Update Section 2's BEFORE/AFTER block — AFTER shows module-scope inline composition with `dispatch:`/`getToken:` callbacks, no `openFuji()` wrapper, no `Document` return type
   - Cut or rewrite the "Document contract and refcount cache" subsection — the contract is gone
   - Update Section 3 to reflect the post-teardown CLI loader shape
   - Add `workspaces-were-documents-all-along.md` to "Articles in this PR"
   - Update test plan: drop checks for removed shapes (`requiresToken`, `setToken`, `Document`/`fromDocument`); add module-scope composition smoke
2. Apply to live PR:
   ```bash
   gh pr edit 1705 --body-file specs/20260425T180000-pr-body-document-primitive.md
   ```
3. Wait for CI green, merge.

### Step 5: draft PR-D prompt

Once PR-A's merged shapes are visible in `main`, draft the awareness-publishing implementation prompt referencing real file paths, types, signatures. Architecture lives in `specs/20260425T000000-device-actions-via-awareness.md`.

### Step 6: draft PR-E prompt

Same pattern for CLI cross-device dispatch, after PR-D lands.

---

## Coordination notes

- **PR-A is sequential within itself**: Phase 1 already on branch; Phase 2 must land on the same branch before merge. No parallel work on the branch from other implementers.
- **PR-D depends on PR-A** for the merged primitive shapes — the awareness publishing references `attachSync` and the closure-composed workspace shape directly.
- **PR-E depends on PR-D** for the awareness state convention.
- **Hard stop on PR-A scope**: PR-A does not absorb PR-D or later work. The arc ends at Phase 2 teardown. New refactors discovered during Phase 2 → new specs, queued behind PR-E.

---

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| PR-A's review takes weeks | Sectioned description + keystone-commit guide gives reviewers entry points. The pure-docs subset (~77 commits) can be split off as a warm-up PR if review momentum stalls. |
| Phase 2 creeps into Phase 3 territory | Phase 2 prompt lists "what's NOT in this phase" with stop-and-report directives. Stop hard; write a new spec for anything past scope. |
| Phase 2 reveals fundamental rework | Reassess at day 7. If something fundamental surfaced, Phase 2 may need to split into its own PR. Don't push through silently. *(Realized: Deletion 3 needed reversal; the resolution was its own spec rather than a Phase 2 split — see `20260425T225350-app-workspace-folder-env-split.md`.)* |
| Awareness publishing turns out to need a primitive | Spec calls this out as the explicit extraction point. Defer until PR-D's implementation surfaces real duplication. |
| The held article rots | v4 coda is short (~3 paragraphs about factory removal). Step 3 above covers it. |
| Drift against main during Phase 2 | Rebase opportunistically (every 2-3 days). Don't let a week of drift accumulate. |

---

## Where to find what

| You want | Look at |
|---|---|
| Why we made these architectural choices | `specs/20260424T180000-drop-document-factory-attach-everything.md` |
| What the cross-device action layer looks like | `specs/20260425T000000-device-actions-via-awareness.md` |
| Phase 2 handoff prompt | `specs/20260425T180001-execution-prompt-phase-2-teardown.md` |
| The PR-A body to paste at finalize time | `specs/20260425T180000-pr-body-document-primitive.md` |
| This roadmap | `specs/20260425T180002-orchestration-tracker.md` (the file you're reading) |
