---
name: specification-writing
description: Write technical specifications that give agents enough context to implement features autonomously. Use when the user says "write a spec", "plan this feature", "create a planning doc", or when planning features, documenting architecture decisions, or creating implementation guides.
metadata:
  author: epicenter
  version: '1.0'
---

# Specification Writing

Follow [writing-voice](../writing-voice/SKILL.md) for prose sections.

A specification gives an agent (or human) the context they need to implement a feature autonomously. The goal is NOT to describe everything exhaustively; it's to provide enough initial context that the implementer can do their own research and make informed decisions.

> **Note**: This guide uses `[PLACEHOLDER]` markers for content you must fill in. Code blocks show templates; replace all bracketed content with your feature's details.

## When to Apply This Skill

Use this pattern when you need to:

- Plan a feature with a spec that enables autonomous implementation.
- Document research findings, trade-offs, and design rationale.
- Define phased implementation tasks with trackable checkboxes.
- Capture open questions and recommendations without over-prescribing.
- Lay out architecture with tables/diagrams instead of wall-of-prose plans.

## The Core Philosophy

Specs should:

- **Provide context, not instructions**: Give the "why" and "what", let the implementer figure out "how"
- **Document research, not conclusions**: Show what was explored, what exists, what doesn't
- **Leave questions open**: The Open Questions section is a feature, not a bug
- **Enable autonomous implementation**: An agent reading this should spawn sub-agents to verify and extend

A good spec is a launching pad, not a script to follow.

**Before outlining sections, apply the [one-sentence-test](../one-sentence-test/SKILL.md).** If you can't name what this spec is about in one concrete sentence, the design isn't coherent yet — that's the finding, and the spec isn't ready.

---

## Decision Hygiene

Every decision in a spec falls into one of three classes. Mixing them up is the single biggest source of spec drift, and the most common reason an otherwise-good spec calcifies around invisible inertia.

**Class 1: Resolved by evidence.** The question has an empirical answer. Don't argue; check.
> "Does Better Auth's `signOut` accept custom headers?" → read the source, write a test, verify the version.

**Class 2: Resolved by design coherence.** The thesis already settled this; the sub-decision just confirms.
> "Should pending polling states be exposed to callers?" → if the thesis says polling is private, no.

**Class 3: Resolved by taste under constraints.** No single right answer. Multiple defensible choices. **Pick deliberately and write the constraint.**
> "Keep this typed wrapper for codebase pattern consistency, or drop it for cleaner pass-through?" → choose; name why.

### Two failure modes

- **Pattern A**: Class 3 disguised as Class 2. "Keep for consistency" sounds principled but is really "I haven't decided." Inertia. Future readers assume the choice was load-bearing.
- **Pattern B**: Class 1 disguised as Class 2. "The new code is in place, delete the old" skips verification. The spec ships with broken assumptions.

The fix for both: name which class each decision is. For Class 3, write the trade-off, not just the choice.

### Active Justification Test

Before locking any "keep" decision in the Design Decisions table, ask:

> "Would I add this if it didn't already exist?"

- **Yes, here's the use case** → Class 2 keep, lock it.
- **No, but removing it is churn** → Class 3 keep by inertia. Name it in the Decisions Log.
- **No, and removing it isn't that hard** → drop it now.

Most "keep for consistency" rationales fail this test.

### Decisions Log

Near the end of the spec, add a small section listing every Class 3 keep with its constraint and a "Revisit when:" trigger.

```markdown
## Decisions log

- Keep `MachineAuthRequestError`: codebase typed-error pattern consistency.
  Revisit when: any caller branches on the discriminator.
- Module-level singleton auth client: ~1-2 ms saved per CLI invocation.
  Revisit when: per-call construction profiles become a real concern.
- Narrow capability types per function: prevents accidental device-plugin
  coupling for status/logout tests.
  Revisit when: type-level overhead exceeds value during maintenance.
```

This makes future reviewers see what's load-bearing vs deferred at a glance. Without it, Class 3 keeps become invisible inertia.

---

## Document Structure

### Header (Required)

```markdown
# [Feature Name]

**Date**: [YYYY-MM-DD]
**Status**: Draft | In Progress | Implemented
**Author**: [Name or AI-assisted]
**Branch**: [optional: feat/feature-name if work has started]
```

### Overview

One paragraph max. Describe what the feature does. Don't sell it.

```markdown
## Overview

[One to two sentences describing what this feature adds or changes and what it enables. Be specific about the capability, not vague about benefits.]
```

### Motivation

Structure as **Current State** → **Problems** → **Desired State**.

```markdown
## Motivation

### Current State

[Show actual code or configuration demonstrating how things work TODAY. Use real code blocks, not prose descriptions.]

This creates problems:

1. **[Problem Title]**: [Specific explanation of what breaks or is painful]
2. **[Problem Title]**: [Specific explanation of what breaks or is painful]

### Desired State

[Brief description of what the target looks like. Can include a code snippet showing the ideal API or structure.]
```

### Research Findings

This is where specs shine. Document what you FOUND, not what you assumed.

```markdown
## Research Findings

### [Topic Researched]

[Description of what you investigated and methodology]

| [Category]    | [Dimension 1]  | [Dimension 2]    |
| ------------- | -------------- | ---------------- |
| [Project/Lib] | [What they do] | [Their approach] |
| [Project/Lib] | [What they do] | [Their approach] |

**Key finding**: [Your main discovery—could be that no standard exists, or that everyone does X]

**Implication**: [What this means for your design decisions]
```

Include:

- What similar projects do (comparison tables)
- What you searched for but didn't find ("No Established Pattern Exists")
- Links or references to documentation you consulted

### Design Decisions

Use a table for traceability. Every decision should have a rationale.

```markdown
## Design Decisions

| Decision            | Choice           | Rationale                       |
| ------------------- | ---------------- | ------------------------------- |
| [Decision point]    | [What you chose] | [Why this over alternatives]    |
| [Decision point]    | [What you chose] | [Why this over alternatives]    |
| [Deferred decision] | Deferred         | [Why it's out of scope for now] |
```

### Architecture

Diagrams over prose. Show relationships visually with ASCII art.

```markdown
## Architecture

[Describe what the diagram shows]
```

┌─────────────────────────────────────────┐
│ [Component Name] │
│ ├── [field]: [type or value] │
│ └── [field]: [type or value] │
└─────────────────────────────────────────┘
│
▼ [relationship label]
┌─────────────────────────────────────────┐
│ [Component Name] │
└─────────────────────────────────────────┘

```

```

For multi-step flows:

```markdown

```

STEP 1: [Step name]
────────────────────
[What happens in this step]

STEP 2: [Step name]
────────────────────
[What happens in this step]

```

```

### Implementation Plan

Break into phases. Use checkboxes for tracking. Phase 1 should be detailed; later phases can be rougher (the implementer will flesh them out).

```markdown
## Implementation Plan

### Phase 1: [Phase Name]

- [ ] **1.1** [Specific, atomic task]
- [ ] **1.2** [Specific, atomic task]
- [ ] **1.3** [Specific, atomic task]

### Phase 2: [Phase Name]

- [ ] **2.1** [Higher-level task—implementer will break down]
- [ ] **2.2** [Higher-level task]
```

#### Wave ordering for clean breaks: Build, Prove, Remove

If the spec replaces an old code path with a new one, structure the waves as four phases:

```txt
1. Build the new path                     (waves 1 to N)
2. Stop importing the old path             (one wave; old code stays on disk, unused)
3. Verify (typecheck, tests, smoke)        (one wave; rollback is one revert)
4. Delete the old path                     (final cleanup wave)
```

If verification fails, rollback is a one-line import flip. Do not collapse step 2 and 3 into "delete the old path before verifying"; that's Pattern B from Decision Hygiene above. See [cohesive-clean-breaks](../cohesive-clean-breaks/SKILL.md) Wave Ordering for the full rationale.

### Edge Cases

List scenarios that might break assumptions or need special handling.

```markdown
## Edge Cases

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome or "See Open Questions"]

### [Scenario Name]

1. [Initial condition]
2. [What happens]
3. [Expected outcome]
```

### Open Questions

This section signals "you decide this" to the implementer. Include your recommendation but don't close the question.

```markdown
## Open Questions

1. **[Question about an unresolved design decision]**
   - Options: (a) [Option A], (b) [Option B], (c) [Option C]
   - **Recommendation**: [Your suggestion and why, but explicitly leave it open]

2. **[Another unresolved question]**
   - [Context about why this is uncertain]
   - **Recommendation**: [Suggestion or "Defer until X"]
```

### Success Criteria

How do we know this is done? Checkboxes for verification.

```markdown
## Success Criteria

- [ ] [Specific, verifiable outcome]
- [ ] [Specific, verifiable outcome]
- [ ] [Tests pass / build succeeds / docs updated]
```

### References

Files that will be touched or consulted.

```markdown
## References

- `[path/to/file.ts]` - [Why this file is relevant]
- `[path/to/pattern.ts]` - [Pattern to follow or reference]
```

---

## Good vs Bad Specs

### Good Spec Characteristics

- **Research is documented**: Shows what was explored, not just conclusions
- **Decisions have rationale**: Every choice has a "why" in a table
- **Questions are left open**: Implementer has room to decide
- **Code shows current state**: Not described abstractly
- **Architecture is visual**: ASCII diagrams over prose
- **Phases are actionable**: Checkboxes that can be tracked

### Bad Spec Characteristics

- **Prescriptive step-by-step**: Reads like a tutorial, no room for autonomy
- **Assumes without research**: "We'll use X" without exploring alternatives
- **Closes all questions**: No Open Questions section
- **Abstract descriptions**: "The system will handle Y" without showing code
- **Wall of prose**: No tables, no diagrams, no structure

---

## Writing for Agent Implementers

When an agent reads your spec, they should:

1. **Understand the problem** from Motivation section
2. **Know what's been explored** from Research Findings
3. **See the proposed direction** from Design Decisions
4. **Have a starting point** from Implementation Plan Phase 1
5. **Know what to investigate further** from Open Questions

The agent will then:

- Spawn sub-agents to verify your research
- Explore the Open Questions you left
- Flesh out later phases of the implementation plan
- Make decisions where you left room

If your spec is too prescriptive, the agent will blindly follow it. If it's too vague, the agent will flounder. The sweet spot is: **enough context to start, enough openness to own the implementation**.

---

## Quick Reference Checklist

```markdown
- [ ] Header (Date, Status, Author)
- [ ] Overview (1-2 sentences)
- [ ] Motivation
  - [ ] Current State (with code)
  - [ ] Problems (numbered)
  - [ ] Desired State
- [ ] Research Findings
  - [ ] Comparison tables
  - [ ] Key findings
  - [ ] Implications
- [ ] Design Decisions (table with rationale)
- [ ] Architecture (ASCII diagrams)
- [ ] Implementation Plan (phased checkboxes)
- [ ] Edge Cases
- [ ] Open Questions (with recommendations)
- [ ] Success Criteria
- [ ] References
```

Not every spec needs every section. A small feature might skip Research Findings. A migration spec might focus heavily on Edge Cases. Use judgment.
