---
name: handoff
description: 'Draft a cold-start, copy-pasteable prompt so a fresh agent can continue, review, or implement this work without reading this thread. Use when the user says "hand this off", "wrap up for the next session", "resume this later", "continue in a new chat", "write a continuation prompt", "make a prompt I can copy-paste", "create a delegation brief", "prompt for an orchestrator", or invokes /handoff. Not for /goal lines (use agent-goal) or for prompts that ship inside product code.'
argument-hint: "What should the next agent accomplish?"
metadata:
  author: epicenter
  version: '3.0'
---

# Handoff

Write the prompt for a competent stranger: a fresh agent with no thread context, possibly starting after this chat is closed. The test: pasted into a blank thread, the recipient can start working without reading this thread or asking what happened.

Return the prompt directly in the conversation so the user can copy it. This skill produces the prompt only; do not launch, supervise, or automate the recipient.

## What The Prompt Must Answer

Write one prompt regardless of recipient type, and cover these points. They are content requirements, not headings: a bounded review ask can cover them in a dozen lines, a multi-day continuation may need a section each.

1. Mission: one concrete outcome and the exact artifact wanted (diff, review memo, updated spec, ADR draft, summary).
2. State: branch, dirty versus committed work, checks already run, and what remains open.
3. Reading list: exact paths, commands, and snippets to read first, with why each matters.
4. Decisions: what is settled and must not be reopened, what is known fact, what is only a recommendation, and which questions are open and whose call they are. Mixing these makes the recipient treat taste as evidence.
5. Boundaries: what may change, what must not, and what adjacent work is out of scope.
6. Plan: ordered next steps concrete enough to start without asking for context.
7. Proof and stop: verification commands, the evidence expected in the final answer, and where to stop instead of continuing into the next phase.

## Rules

- Paste real code or command output when it is shorter than explaining it. Use real paths, never vague references.
- Do not duplicate specs, plans, commits, or diffs. Link the stable path and summarize the decision it carries.
- Use absolute dates. "Today", "yesterday", and "recently" rot.
- Do not imply the recipient has tools, credentials, apps, or subagents unless the user said so. Write "when available" when a step depends on the harness.
- Bound the work. If the recipient should not implement, say so; if implementation may follow, ask for a separate execution handoff after the decision pass.

## Shape It To The Job

- Edits: send the recipient to a disposable git worktree on its own branch, break work into commit-sized waves, and note that the final diff still gets local review.
- Review: one concrete question with exact paths or a diff command. Ask for findings, risks, and gaps, not approval.
- Delegation: a recipient that can spawn subagents keeps synthesis and the final artifact; each delegated piece gets one question, bounded sources, and one deliverable. Name specific models or agents only when the user did.
- Adversarial rework: for a grill, greenfield pass, or clean break, tell the recipient not to defer to prior conclusions, to state what would falsify the current direction, and to name refusals with the value each gives up.

For a `/goal` one-liner, use [agent-goal](../agent-goal/SKILL.md). For a human-facing progress summary, use [progress-summary](../progress-summary/SKILL.md).
