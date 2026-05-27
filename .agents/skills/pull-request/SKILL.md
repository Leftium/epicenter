---
name: pull-request
description: 'Draft and review GitHub pull request titles and bodies for Epicenter. Use when creating a PR, running gh pr create, drafting a PR body, editing a pull request description, writing changelog entries, linking issues from a PR, choosing merge strategy, or reviewing PR text. Never include Testing, Test Plan, or Verification sections in PR bodies unless explicitly requested.'
metadata:
  author: epicenter
  version: '1.0'
---

# Pull Request Guidelines

## Use This For

Use this skill to write or review PR titles, PR descriptions, changelog entries, issue closing language, GitHub username verification, reviewer guidance, and merge strategy.

If the task is only staging, splitting, or committing local changes, use [git](../git/SKILL.md). If the task is issue triage or public issue replies, use [github-issues](../github-issues/SKILL.md).

## Hard Rules

- Write PR descriptions as continuous narrative prose, opening with WHY.
- Never include `## Summary`, `## Changes`, `## Testing`, `## Test Plan`, or `## Verification` sections unless the user explicitly asks.
- Report commands run, tests run, and verification gaps in the chat final response, not the PR body.
- Do not list changed files. The diff tab already does that.
- Do not include AI or tool attribution.
- Add a `## Changelog` section only for `feat:` and `fix:` PRs with user-visible changes.

## References

Load these on demand based on what you're working on:

- If working with **PR description structure, API examples, and visual communication**, read [references/pull-request-guidelines.md](references/pull-request-guidelines.md). This is style and review communication guidance.
- If working with **changelog entries for `feat:` or `fix:` PRs**, read [references/changelog-entries.md](references/changelog-entries.md).
- If working with **GitHub issue linking, username verification, CODEOWNERS, or merge strategy**, read [references/github-pr-operations.md](references/github-pr-operations.md). This is GitHub platform and `gh` CLI guidance for PRs.
