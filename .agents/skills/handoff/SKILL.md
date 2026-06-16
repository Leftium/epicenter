---
name: handoff
description: Draft a self-contained, copy-pasteable prompt so a fresh agent can continue without this thread. Use when the user says "hand this off", "compact this", "wrap up for the next session", "write a continuation prompt", "draft a prompt", "make a prompt I can copy-paste", "create a delegation brief", or invokes /handoff.
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '2.0'
---

# Handoff

Draft a self-contained prompt that can be pasted into a fresh agent thread or separate session.

Return the prompt directly in the conversation. The user can copy it from there.

The recipient has no thread context. Include only what they need to continue correctly.

Do not launch, supervise, or automate the recipient. This skill produces the prompt only.

## Include

- Goal: what the next agent should accomplish.
- Current state: what is done, what is dirty, what is committed, and what is still open.
- Important files: exact paths and why they matter.
- Decisions: choices already made and choices not to reopen.
- Constraints: repo rules, commands, style rules, and things to avoid.
- Next steps: ordered, concrete actions.
- Verification: commands already run and commands still needed.

For a bounded review prompt, make the goal one concrete question. Include exact
file paths, short snippets, or the diff command to run, and say what answer shape
will be useful.

If the prompt asks the recipient to edit files, direct that work to a disposable
git worktree on its own branch. The final diff still needs local review before
it lands.

## Write It For A Cold Reader

Paste real code or command output when it is shorter than explaining it. Use real file paths instead of vague references.

Do not duplicate full specs, plans, decision docs, commits, or diffs. Link to stable paths and summarize the decision they contain.

Close decisions the recipient should not spend time reopening. If a choice is still genuinely open, name the owner and the exact question.

A good handoff can be pasted into a blank agent thread and executed without a clarifying question.
