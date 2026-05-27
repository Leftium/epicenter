---
name: to-prd
description: Turn the current conversation context into a Product Requirements Document. Use when the user says "write a PRD", "turn this into a PRD", "make a PRD from this conversation", "ship this as a product brief", or wants to capture an in-progress discussion before issues or specs are broken out.
metadata:
  upstream: mattpocock/skills
  forked: 2026-05-17
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Synthesize first. Ask the user only when a product decision blocks a truthful PRD.

Publish to the issue tracker only when the user asks for that or the project workflow clearly expects it. If publishing, the issue tracker and triage label vocabulary should have been provided to you. Run `/setup-matt-pocock-skills` if not.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch the product surface, system boundaries, and implementation decisions that are already implied by the conversation. Use the project's domain language. Name stable interfaces, data shapes, commands, or routes when they clarify the PRD.

3. Separate product requirements from implementation notes. A PRD can include technical decisions when they materially constrain the product, but it should not become a step-by-step implementation spec.

4. Write the PRD using the template below. If publishing to the issue tracker, apply the `ready-for-agent` triage label only when the PRD is specific enough for agent execution.

<prd-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

Representative user stories. Include enough to cover the core actors and workflows, but do not pad the list.

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

## Implementation Decisions

A list of implementation decisions already established by the conversation. This can include:

- The modules, boundaries, or surfaces that will change
- The interfaces, commands, routes, schemas, or contracts involved
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Prefer durable names over fragile file paths. Include file paths only when they are stable project landmarks or when the path itself is part of the product or ownership boundary.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which behaviors or boundaries need tests
- Prior art for the tests (i.e. similar types of tests in the codebase)
- Manual verification that remains necessary, especially for platform, integration, or release flows

## Deferred, Refused, Opportunistic

Separate adjacent work by decision type:

- Deferred: not required now, allowed later.
- Refused: deliberately not part of the product or design.
- Opportunistic: not required, but acceptable to fix if discovered and grounded.

## Further Notes

Known risks, unresolved product questions, rollout notes, or links to specs and issues.

</prd-template>
