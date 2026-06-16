---
name: handoff
description: Draft a self-contained, copy-pasteable prompt for a fresh agent, terminal agent UI, or bounded review. Use when the user says "hand this off", "compact this", "wrap up for the next session", "write a continuation prompt", "draft a prompt", "make a prompt I can copy-paste", "create a delegation brief", "ask Claude", "get another model's take", "taste check", or invokes /handoff.
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '2.0'
---

# Handoff

Draft a self-contained prompt that can be pasted into a fresh agent thread, a terminal agent UI, or another separate session.

Return the prompt directly in the conversation. The user can copy it from there.

The recipient has no thread context. Include only what they need to continue correctly.

Do not build or run a wrapper for the recipient. Let the user run their chosen terminal UI so the account, session, model choice, and rate-limit pool stay visible to them.

## Include

- Goal: what the next agent should accomplish.
- Current state: what is done, what is dirty, what is committed, and what is still open.
- Important files: exact paths and why they matter.
- Decisions: choices already made and choices not to reopen.
- Constraints: repo rules, commands, style rules, and things to avoid.
- Next steps: ordered, concrete actions.
- Verification: commands already run and commands still needed.

## Narrow Review Prompts

Most handoffs are continuation prompts. When the user wants another agent's judgment rather than a fresh owner for the work, make the prompt narrower: one question, exact context, and an answer shape Codex can verify.

Use a narrow review prompt only when diversity, isolation, parallelism, or clear verification makes it useful. Keep the work in Codex when the edit is faster to make locally, needs delicate repo judgment, or would mostly produce prose or vibes.

Write the prompt like a senior engineer asking another senior engineer for one bounded judgment:

1. Ask one concrete question.
2. Give exact file paths or short snippets, or tell the user which diff to pipe in.
3. Name the lens: debugging hypotheses, taste critique, clean-break pressure, risk review, or implementation-option review.
4. Say what answer shape is useful.
5. Say the recipient's answer is advisory. Codex verifies and owns what lands.

For architecture or API-shape questions, ask the recipient to start with one concrete sentence describing the current surface, then look for radical options, asymmetric wins, and clean breaks before local patches.

Split a broad ask into two focused prompts, such as a pre-edit risk pass and a post-edit diff pass, instead of one omnibus prompt covering placement, design, tests, naming, and migration at once.

If the user wants the other agent to edit files, direct that work to an explicit disposable git worktree on its own branch. Codex reviews the diff, applies only what fits, stages specific files, and verifies.

## Write It For A Cold Reader

Paste real code or command output when it is shorter than explaining it. Use real file paths instead of vague references.

Do not duplicate full specs, plans, decision docs, commits, or diffs. Link to stable paths and summarize the decision they contain.

Close decisions the recipient should not spend time reopening. If a choice is still genuinely open, name the owner and the exact question.

A good handoff can be pasted into a blank agent thread and executed without a clarifying question.
