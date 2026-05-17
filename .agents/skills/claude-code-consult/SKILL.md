---
name: claude-code-consult
description: Use this skill when the user asks to consult Claude, ask Claude Code, get another model's take, run a taste check, find cleaner options, or prepare a Claude prompt. Create a bounded second-opinion prompt or run a read-only Claude Code consult, then verify Claude's claims against local files.
---

# Claude Code Consult

Use this skill to turn "ask Claude" into a bounded second opinion. The default output is a copy-paste prompt, not an automatic command.

The consult is advisory. The current agent still owns the repo, reads the answer critically, and decides what to change.

## Core Rule

Do not mechanically dump a template.

Write the prompt a sharp human would send to a second senior engineer. Use only enough structure to prevent vagueness.

The consult should usually do four things:

1. Pin Claude to one concrete question.
2. Give Claude the exact local context it needs.
3. Choose the right critique lens.
4. Say what answer shape would be useful.

The shortest good prompt is often better than the most complete prompt.

## Critique Lens

Choose the lens based on the user's actual question.

Use clean-break pressure when the user asks about architecture, API shape, migration, abstraction pressure, naming, or taste:

- [one-sentence-test](../one-sentence-test/SKILL.md): ask for one concrete sentence that describes the current surface.
- [radical-options](../radical-options/SKILL.md): ask what cleaner shape exists if we stop preserving the current abstraction.
- [cohesive-clean-breaks](../cohesive-clean-breaks/SKILL.md): ask which small refusal deletes a large code family, and who loses what.

Do not force those lenses onto every consult. For debugging, ask for ranked hypotheses and the cheapest next test. For copy or UI taste, ask for concrete alternatives and why they fit the product.

## Default Posture

Prefer manual prompt handoff first.

Programmatic `claude -p` calls are useful after the prompt shape is stable, but they add auth, sandbox, cost, and permission concerns. Do not start with auto mode unless the user explicitly asks to run Claude Code from the terminal.

Manual handoff is better when:

- The consult needs taste, judgment, or a careful read.
- The user may want to steer the conversation after Claude answers.
- The prompt includes long file snippets or nuanced context.

Programmatic invocation is better when:

- The prompt is short and repeatable.
- The expected answer is structured.
- The user explicitly wants Codex to run the consult.
- The consult is read-only and cannot mutate the repo.

Use Claude Code for:

- Architecture critique.
- Taste checks on UI, API, naming, and abstraction boundaries.
- Hard debugging hypotheses.
- Refactor risk review.
- Alternatives when the current solution feels trapped inside a bad abstraction.
- A skeptical review before a broad change.
- Clean-break review before preserving old compatibility.
- Asymmetric-wins review when one rare mode may be forcing too much code.

Do not use Claude Code for:

- Routine edits the current agent can safely make.
- Final authority on whether code is correct.
- Autonomous repo changes without user approval.
- Open-ended "think about everything" prompts.

## Prompt Contract

Every consult prompt must be narrow enough that Claude can answer in one pass.

Include:

- The decision or question.
- The exact files or snippets to inspect. Paste code when it is short enough to matter; do not paraphrase code that Claude needs to judge.
- The local constraints that matter.
- What kind of answer is wanted.
- What not to do.

Ask for findings, tradeoffs, or a recommendation. Avoid asking Claude to implement unless the user specifically wants a second agent to write code.

## Prompt Shape

Default to a natural prompt like this:

```txt
Claude Code consult prompt:

I want a bounded second opinion, not implementation.

Question:
[One concrete question.]

Context:
[Only the file paths, snippets, and constraints Claude needs.]

Please give a concrete recommendation and the reasoning behind it. Use the relevant lens for this question: debugging hypotheses, taste critique, or clean-break pressure. If this is an architecture or API-shape question, start with the one-sentence read of the current surface, then look for radical options, asymmetric wins, and clean breaks before suggesting local patches.

Do not edit files, run destructive git commands, or give generic best practices.
```

If the prompt feels like a form letter, compress it. Keep the question, context, and chosen lens; drop ceremony.

## Running Claude Code Manually

If the user wants to run the prompt themselves, provide only the prompt.

If the user asks Codex to run Claude Code and `claude` is installed, use a single non-interactive invocation:

```bash
claude -p "[prompt]"
```

Before running it, confirm the prompt does not request file edits unless the user explicitly asked for that. If the command fails because of auth, sandbox, or network restrictions, report that directly and fall back to manual handoff.

## Reviewing The Answer

After Claude responds:

1. Separate concrete findings from opinion.
2. Check each claim against local files.
3. Keep only recommendations that fit the repo constraints.
4. Make the smallest useful change in Codex, with normal validation.

Do not relay Claude's answer as final truth. Treat it like a strong code review comment: useful when it cites mechanisms, weak when it speaks in generalities.
