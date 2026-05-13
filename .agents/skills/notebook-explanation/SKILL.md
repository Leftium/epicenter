---
name: notebook-explanation
description: "Explain technical systems in a notebook style: short working notes, small code blocks, ASCII diagrams, concrete examples, and compressed rules. Use when the user asks to understand architecture, APIs, auth flows, specs, boundaries, code ownership, or design tradeoffs as a newcomer."
metadata:
  author: epicenter
  version: '1.0'
---

# Notebook Explanation

Use this skill when the user wants to understand a technical system, not just receive a polished answer. Write like private working notes from someone trying to make the system obvious to themself.

The point is compression:

```txt
term = meaning
boundary = owner
flow = step by step
rule = durable takeaway
```

If a design cannot survive this format, the design is probably muddy.

## Shape

Start with the question.

```txt
Question:
  What are we trying to understand?

Short answer:
  One sentence.
```

Then build the model in small blocks:

```txt
Notebook model:
  term = meaning
  term = meaning

Flow:
  thing A
    -> thing B
    -> thing C

Good:
  small concrete example

Bad:
  confusing or overbroad example

Rule:
  durable takeaway
```

## Style Rules

- Prefer code blocks over long prose when naming ownership, state, flows, boundaries, or tradeoffs.
- Use short paragraphs only to bridge code blocks.
- Use tiny definitions before diagrams.
- Show "good" and "bad" when a boundary can drift.
- Keep examples concrete: real package names, file names, scopes, route names, or type names.
- Avoid abstract architecture language unless it is immediately grounded in a small example.
- Avoid explaining every edge case up front. Teach the core model first, then name the edge case if it changes the model.
- Avoid bold-heavy formatting. The notebook blocks should carry the structure.

## Architecture Explanations

For architecture, show ownership first:

```txt
apps/server owns:
  private workspace auth
  private workspace sync

apps/cloud owns:
  public product modules
  public records

module owns:
  routes
  schemas
  scope names

network owns:
  domain
  records
  policy

token owns:
  identity proof
  audience
  scopes

policy owns:
  exact product rule
```

Then show the flow:

```txt
private draft
  -> explicit publish
  -> network API
  -> public record
```

## API And Auth Explanations

For API, auth, and capability boundaries, separate where, what, and policy:

```txt
audience = where the token works
scope    = what the client can attempt
policy   = whether this user can do this exact thing now
```

Good:

```txt
audience: https://ark.alice.com
scope:    ark:publish
policy:   user is allowed to publish to Alice's network
```

Bad:

```txt
scope: ark:alice:post:create:public:not-banned
```

## Code Break Explanations

When showing code organization, make the folder tree express ownership:

```txt
apps/cloud/src/
  modules/
    ark/
      routes.ts
      schema.ts
      scopes.ts
      policy.ts
  networks/
    config.ts
    host-dispatch.ts
```

Then show the smallest useful type or function:

```ts
type Network = {
  host: string;
  module: string;
  audience: string;
  supportedScopes: string[];
};
```

## When To Stop

Stop once the reader can answer:

```txt
What is this thing?
Who owns it?
Where does data flow?
What is the rule of thumb?
What is the tempting wrong version?
```

Do not keep adding sections just because the topic is large.
