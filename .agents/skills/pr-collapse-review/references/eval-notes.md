# PR Collapse Review Eval Notes

Use this file when tuning trigger behavior, checking whether this skill still
earns its own place, or deciding whether to add a script.

## Classification

This is a process skill with light tool workflow mechanics.

It should stay separate from `collapse-pass` because PR checkout, worktree
isolation, changed-file scoping, and recent-PR sweeps are different triggers
from package-wide collapse passes.

## Source Material

- PR 1930 collapse review transcript from June 13, 2026.
- `collapse-pass` skill and references.
- `skill-creator` guidance on repeatable project expertise, progressive disclosure, description tuning, and validation.
- Agent Skills docs on real source material, compact skill bodies, trigger evals, and scripts.

## Should Trigger

- "Run a collapse review on https://github.com/EpicenterHQ/epicenter/pull/1930 in a fresh worktree."
- "Can you check the last three merged PRs and find any asymmetric collapses?"
- "Review this branch like PR 1930: inline helpers, report findings first, then fix the clear wins."
- "Open a new worktree and grill this PR for dead wrappers and stale boundaries."

## Should Not Trigger

- "Run a collapse pass on packages/workspace." Use `collapse-pass`.
- "Review my staged diff for bugs." Use normal code review or `post-implementation-review`.
- "Create a PR title and body." Use `pull-request`.
- "Teach me how git worktrees work." Answer directly or use a teaching skill.

## Assertions

A good run should:

- Use a separate worktree by default unless the user opts out.
- Compute scope from the PR, branch, or commit range.
- Print files read as an ASCII tree before analysis.
- Report findings before editing.
- Fix only grounded findings and explicitly defer the rest.
- Re-read touched files after edits.
- Run targeted `bun` tests or typechecks for impacted packages.
- End with worktree path, verification, fixed findings, deferred findings, and rejected collapse candidates.

## No Script Yet

Do not add a helper script until at least three real runs show the agent
repeatedly gets worktree setup, PR checkout, or changed-file scoping wrong.

If a script becomes necessary, it should be non-interactive, dry-run capable,
use structured stdout, diagnostics on stderr, and accept explicit flags for PR,
base, target branch, and worktree path.
