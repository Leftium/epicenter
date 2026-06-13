---
name: pr-collapse-review
description: Run an isolated collapse-oriented review of a pull request, branch, or recent merged change. Use when the user asks to review a PR for simplification, collapse recent PRs, check whether a change can delete more indirection, run the PR in a new worktree, or apply grounded cleanup fixes after a PR review. Composes with collapse-pass, git, post-implementation-review, and claude-code-consult when another model is requested.
metadata:
  author: epicenter
  version: '1.0'
---

# PR Collapse Review

Use this skill for PR-shaped collapse work: start from a pull request, branch,
or recent merged change, isolate it in a worktree by default, then use
`collapse-pass` to find and fix grounded simplifications.

This skill owns the PR mechanics. `collapse-pass` owns the simplification
posture and finding ritual.

## Compose With

- `collapse-pass`: required for the inlining posture, anti-cosmetic gate, smell catalog, and final report shape.
- `git`: branch, worktree, staging, commit, and message conventions.
- `post-implementation-review`: required before final handoff after edits.
- `claude-code-consult`: optional when the user asks to consult Claude or another model.

## Required Inputs

Get one of these from the user or local context:

- PR URL or PR number.
- Branch name and base branch.
- Recent merged PR count or commit range.

If the base branch is unknown, infer it from the PR metadata, upstream tracking
branch, or `origin/main` in that order.

## Default Worktree

Use a separate worktree unless the user explicitly asks to work in the current
checkout.

For a GitHub PR number:

```bash
git fetch origin
git fetch origin pull/<number>/head:codex/pr-<number>-collapse-review
git worktree add ../epicenter-pr-<number>-collapse codex/pr-<number>-collapse-review
```

For a named branch:

```bash
git fetch origin <branch>:codex/<branch>-collapse-review
git worktree add ../epicenter-<branch-slug>-collapse codex/<branch>-collapse-review
```

Use a filesystem-safe `<branch-slug>` for the directory, replacing slashes with
hyphens. Use a unique branch or directory suffix if either name already exists.
Do not use a destructive git command to reset the user's active checkout.

For recent merged PR sweeps, use one worktree and one branch for the sweep:

```bash
git worktree add ../epicenter-recent-pr-collapse -b codex/recent-pr-collapse origin/main
```

## Workflow

1. Load `collapse-pass` before reviewing code. Read its required references before any edit.
2. Create or enter the review worktree. Confirm branch, base, and target.
3. Compute the changed files against base with `git diff --name-only <base>...HEAD`.
4. Read changed files first, then direct callers, tests, owned docs, and upstream docs only when external behavior affects correctness.
5. Before analysis, list every file read as an ASCII tree.
6. Report grounded findings before editing:

   ```txt
   Finding N: <smell>
   Inline check: <what mental inlining showed>
   Fix: <proposed change>
   What stays the same: <visible behavior, durable strings, blob layout>
   ```

7. Apply only findings that clear the evidence bar. Defer product, compatibility, or broad ownership questions with evidence.
8. After edits, re-read every touched file and run `post-implementation-review`.
9. Run targeted tests and typechecks for impacted packages. Use `bun`, never npm, yarn, pnpm, or npx.
10. End with files read, findings fixed, findings deferred, verification, and any rejected collapse candidates.

## Keep Going

Continue until every grounded finding in the PR scope is fixed, rejected, or
explicitly deferred with evidence. Stop early only when tests or typechecks
cannot be restored in one follow-up, the remaining findings require product
input, the user gave a budget, or three consecutive scoped files produce no
findings.

## Claude Consult

Use `claude-code-consult` only when the user requests another model or when
diversity of judgment clearly matters. Codex remains the harness: Claude may
advise, scout, or edit only in an isolated worker worktree, and Codex verifies
anything that lands.

For PR collapse work, prefer two small consults over one broad consult:

1. A pre-edit design or risk pass over the reported findings.
2. A post-edit review pass over the final diff.

## Guardrails

- Do not silently fix structural concerns. Report them first.
- Do not broaden from touched files into unrelated cleanup without evidence.
- Do not change durable strings, schemas, or public contracts unless the user explicitly requested greenfield cleanup and the finding names why compatibility no longer earns its cost.
- Do not stage, commit, push, or open a PR unless the user asks.
- Do not leave the worktree dirty without reporting its path and state.

## References

Read [references/eval-notes.md](references/eval-notes.md) when tuning this
skill's description, deciding whether it still earns its own skill, or adding a
script after repeated runs.
