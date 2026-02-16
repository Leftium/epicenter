---
name: technical-articles
description: Writing technical articles and blog posts. Use when creating articles in docs/articles/ or blog content explaining patterns, techniques, or lessons learned.
---

# Technical Articles

All articles must follow [writing-voice](../writing-voice/SKILL.md) rules.

## Core Principles

Title should BE the takeaway, not a topic. "Write Context to a File, Not a Prompt" not "Context Management in Agent Workflows".

Lead with a strong opening paragraph that states the key insight in plain language. Reader should get it in 5 seconds. Then go straight into code. Don't force a blockquote or pull-quote after the opening; if the insight needs a quotable summary, the opening paragraph already is one.

Code speaks louder than prose. Show real examples from actual codebases, not abstract `foo`/`bar` illustrations. If the code is self-explanatory, don't over-explain.

ASCII diagrams for architecture or flow:

```
Conversation          Spec File           Subagent
    │                    │                   │
    │  write context     │                   │
    │───────────────────>│                   │
    │                    │                   │
    │                    │   read file       │
    │                    │<──────────────────│
    │                    │                   │
    │                    │   fresh context   │
    │                    │──────────────────>│
```

Tables for comparisons (skim-friendly, respect reader time):

| Instead of                | Do this            |
| ------------------------- | ------------------ |
| Copy-pasting context      | Write to spec file |
| Re-explaining each prompt | Pass the filename  |

## Rhythm and Pacing

This is the most important section. Good articles alternate between prose and visuals. The reader's eye should bounce: context → code → explanation → diagram → implication. Neither prose nor code should dominate for long stretches.

### The Rules

1. **Max 3-4 sentences of prose before a code block, diagram, or table.** If you're writing more than that without a visual break, you're missing an opportunity.
2. **Every code block gets 1-2 sentences of setup before it.** Don't drop code without context. But don't write a paragraph either.
3. **After a code block, one sentence of explanation is often enough.** If the code is self-explanatory, skip it entirely and bridge to the next idea.
4. **Use line breaks between distinct thoughts.** Don't pack three ideas into one paragraph. Each paragraph: one idea.

### Good rhythm — prose and code alternate:

```
[1-2 sentences: what the problem is]

\`\`\`typescript
// code showing the problem
const result = table.find(id);  // O(n) scan every time
\`\`\`

[1 sentence: why this is bad, bridge to solution]

\`\`\`typescript
// code showing the solution
const result = index.get(id);   // O(1) lookup
\`\`\`

[1-2 sentences: what this means for the reader]
```

### Bad rhythm — wall of prose, code at the end:

```
[Paragraph explaining the problem]
[Paragraph explaining the approach]
[Paragraph explaining the implementation]
[Paragraph explaining the result]

\`\`\`typescript
// single code block at the bottom
\`\`\`
```

The first version lets the reader verify each claim against code as they go. The second forces them to hold four paragraphs in memory, then mentally map them to code.

## Writing the Opening

The opening paragraph carries the entire article. If someone reads nothing else, this paragraph should give them the insight.

Bad (topic announcement):

> In this article, we'll explore how context management works in agent workflows and discuss some approaches to improving it.

Good (insight up front):

> Write your context to a file, not a prompt. When a conversation spawns sub-agents, each one starts with a blank slate. If the context lives in a spec file on disk, every agent can read it fresh instead of relying on copy-pasted prompt fragments that drift.

The bad version tells the reader what the article is about. The good version tells them the answer. They'll keep reading to see why.

## Writing Explanatory Prose

When you need to explain how something works between code blocks, show the mechanism. Don't describe it abstractly.

Bad (abstract narration):

> The system uses a layered approach to handle data storage efficiently. Each layer provides a different level of abstraction, allowing consumers to interact with data at the appropriate granularity for their use case.

Good (shows the mechanism):

> `RowStore` wraps `CellStore`, which wraps `YKeyValueLww`. Each layer adds one thing: `YKeyValueLww` handles conflict resolution, `CellStore` parses cell keys into row/column pairs, and `RowStore` maintains an in-memory index for O(1) lookups. The consumer only sees `RowStore`.

The first version could describe anything. The second version could only describe this system.

## Constraints

Bullet lists and numbered lists: max 1-2 of each per article. If you need more, convert to prose or a table.

Section headings: use sparingly. Not every paragraph needs a heading. Let content flow naturally between ideas using bridge sentences (see [writing-voice](../writing-voice/SKILL.md) "Connect ideas without headers").

Bold text: avoid in body content. Use sparingly if needed for emphasis.

No space-dash-space: use colons, semicolons, or em dashes per writing-voice.

No rigid template: structure should fit the content, not the other way around. Some articles need a "Problem/Solution" flow; others just show code and explain. Don't force sections.

## Reference: Complete Article Skeleton

This is NOT a template to follow mechanically. It's a reference showing what a well-paced 60-line article looks like. Your article's structure should fit its content.

````
# Write Context to a File, Not a Prompt

When a conversation spawns sub-agents, each one starts fresh. If your context
lives only in the conversation, you'll re-explain it every time. Write it to a
file instead.

```typescript
// Instead of crafting a long prompt with embedded context:
task({ prompt: `Here's the schema: ${schema}. Here's the migration plan: ${plan}. Now implement step 3...` })

// Write context to a spec file, then reference it:
await writeFile('specs/migration-plan.md', context);
task({ prompt: 'Read specs/migration-plan.md and implement step 3.' })
```

The spec file solves three problems at once. Sub-agents get full context without
prompt bloat. The context doesn't drift between invocations because there's one
source of truth. And you can read the file yourself to verify what agents are
working from.

```
Conversation          Spec File           Sub-agent
    │                    │                   │
    │  write context     │                   │
    │───────────────────>│                   │
    │                    │   read file       │
    │                    │<──────────────────│
    │                    │   fresh context   │
    │                    │──────────────────>│
```

This also changes how you think about agent prompts. Instead of "give the agent
all the context it needs," the question becomes "does the spec file contain
everything?" That's a better question because you can check it: open the file,
read it, see if it's complete.

| Without spec file             | With spec file              |
| ----------------------------- | --------------------------- |
| Context drifts per invocation | Single source of truth      |
| Prompt grows with complexity  | Prompt stays short          |
| Can't verify what agent sees  | Read the file yourself      |
| Copy-paste between agents     | All agents read same file   |

The overhead is one file write. The payoff is every sub-agent in the
conversation working from the same, verifiable context.
````

Notice the pattern: opening insight → code showing the technique → prose explaining why → ASCII diagram showing the flow → table summarizing the comparison → one-sentence closing. Each prose section is 2-4 sentences. Each visual earns its place.

## What Makes Articles Good

- Real code from real codebases, not abstract examples
- ASCII diagrams that clarify architecture or data flow
- One table that summarizes the key comparison
- Tight prose that explains WHY, not WHAT (code shows WHAT)
- Prose and visuals alternate every 2-4 sentences
- Opening paragraph delivers the insight, not a topic announcement
- 30-80 lines for focused insight articles; comparison or analysis articles naturally run 80-150+ when showing code from multiple libraries

## What Makes Articles Bad

- Rigid section structure that doesn't fit the content
- Multiple bullet lists and numbered lists throughout
- Abstract `foo`/`bar` code examples
- Over-explaining self-explanatory code
- Bold formatting scattered through body text
- Marketing language or AI giveaways
- More than 4-5 sentences of prose without a visual break
- Opening that announces the topic instead of delivering the insight
- Closing that reaches for a grand summary or call to action

## Narrative Mode (Rare)

Most "journey to an insight" articles still work better as punchy. Use narrative only when the discovery process itself is the insight and can't be compressed.

When narrative fits: specific details ("750 lines", not "a large file"), direct statements over manufactured drama, build to an insight rather than starting with it.

## Closings

End with a plain statement of the implication. Don't reach for a grand summary or a clever sign-off. If the article showed that X solves Y, just say what that means for the reader in one or two sentences. Avoid closing with superlatives ("the most elegant", "truly powerful") or calls to action ("try it today!").
