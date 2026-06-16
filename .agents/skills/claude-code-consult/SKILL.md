---
name: claude-code-consult
description: Use when the user asks to consult Claude, ask Claude Code, get another model's take, run a taste check, grill a design, find cleaner options, prepare a Claude prompt, or delegate a bounded second opinion. Codex drafts the prompt; the user runs Claude themselves in their terminal. Codex stays the harness and owns verification, edits that land, commits, and final correctness.
---

# Claude Code Consult

Codex is the harness. It does not run Claude. When a second model's take is useful, Codex drafts a sharp prompt for the user to paste into their own Claude Code terminal, then folds the answer back into the work. Running Claude manually keeps the user's account, session, and rate-limit pool visible to them.

Claude is good for consults, taste checks, design critique, risk review, and bounded alternative patches. It is a consultant, never the final authority. Codex still owns verification and every change that lands.

## When To Draft A Claude Prompt

Do not reach for Claude just because you can. Draft a prompt only when at least one of these is true:

```txt
diversity      another model may catch a design or reasoning mistake Codex would miss
isolation      the work can run safely outside Codex's active worktree
parallelism    the user can let Claude investigate while Codex keeps working
verification   the result is checkable by diff, tests, typecheck, docs, or screenshots
```

Keep it in Codex when the edit is faster to make locally, the task needs delicate repo judgment, or the result would be mostly prose or vibes.

## Writing The Prompt

Write what a sharp senior engineer would send to another senior engineer, not a filled-in template.

1. Ask one concrete question.
2. Give exact file paths or short snippets, or tell the user which diff to pipe in.
3. Name the lens: debugging hypotheses, taste critique, clean-break pressure, risk review, or implementation-option review.
4. Say what answer shape is useful.
5. Tell Claude not to treat its answer as final. Codex verifies and owns what lands.

For architecture or API-shape questions, ask Claude to start with one concrete sentence describing the current surface, then look for radical options, asymmetric wins, and clean breaks before local patches.

Split a broad ask into two focused prompts (for example a pre-edit risk pass and a post-edit diff pass) rather than one omnibus prompt covering placement, design, tests, naming, and migration at once.

## If Claude Edits Files

A consult is read-only by default: the user asks, Claude answers. If the user wants Claude to attempt edits or an alternative patch, that should happen in an explicit disposable git worktree on its own branch, not in Codex's active worktree, unless the user intentionally chooses otherwise. Codex then reviews the diff, applies what it wants, stages specific files, and verifies.

## Verification

Treat Claude's output like a strong code review comment, not truth.

1. Separate concrete findings from opinion.
2. Check each claim against local files, installed types, official docs, DeepWiki, or tests.
3. Keep only what fits repo constraints.
4. Run the relevant `bun` commands yourself before committing.

If an answer is generic, unsupported, contradicted by local files, or incompatible with this repo, discard that part and say so.
