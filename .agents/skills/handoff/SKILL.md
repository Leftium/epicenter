---
name: handoff
description: Compact the current conversation into a self-contained handoff document or cold execution prompt so a fresh agent can continue without prior context. Use when the user says "hand this off", "compact this", "wrap up for the next session", "write a continuation prompt", "draft a prompt", "make a prompt I can copy-paste", "create a delegation brief", or invokes /handoff at the end of a long working session.
argument-hint: "What will the next session be used for?"
metadata:
  upstream: mattpocock/skills
  forked: 2026-05-17
---

# Handoff

Create the smallest artifact that lets a fresh agent continue correctly.

## Pick The Shape

Use a **continuation handoff** when the user is wrapping this session or wants another agent to resume the same work. Save it to a path produced by `mktemp -t handoff-XXXXXX.md` (read the file before you write to it).

Use a **cold execution prompt** when the user asks for a prompt they can copy, paste, or delegate. Return the prompt in the conversation unless they ask for a file.

## Continuation Handoff

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Suggest the skills to be used, if any, by the next session.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.

## Cold Execution Prompt

A cold execution prompt is for a recipient who has never seen this codebase, this conversation, or this context. Everything they need to execute must be in the prompt itself.

Include:

- Task statement: one or two sentences naming what to build and where.
- Context: concrete file paths, relevant code snippets, existing patterns, and constraints.
- Requirements: behavior, edge cases, integration points, and verification expectations.
- Decisions: close choices the recipient should not reopen.
- Starting lane: the files, package, app, or spec to inspect first.

Paste real code when it is shorter and clearer than a paraphrase. Real file paths beat vague references. If the recipient would need to grep for a fact before starting, include that fact.
