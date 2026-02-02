# TanStack AI's Isomorphic Tool Pattern

TanStack AI has this really elegant way of defining tools for AI agents. The pattern clicked for me when I realized it's solving a tricky problem: how do you share type definitions between server and client while keeping implementations where they belong?

Let me walk you through it.

## The Problem

When building AI chat applications, you often need tools that run in different places:

- **Server tools**: Query databases, call APIs, access secrets
- **Client tools**: Update UI, show notifications, use browser APIs

But you want type safety everywhere. If the LLM calls `search_recordings`, both your server code and client code should know exactly what arguments it expects and what it returns.

The naive approach would be to define the tool schema twice; once on the server, once on the client. But that's a maintenance nightmare. Change one, forget to update the other, and you've got runtime errors.

## The Solution: Define Once, Implement Anywhere

TanStack AI splits tool creation into two steps:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Step 1: Define the CONTRACT (shared)                                      │
│   ─────────────────────────────────────                                     │
│   toolDefinition({ name, inputSchema, outputSchema })                       │
│                                                                             │
│   This is just the schema. No implementation. Import it anywhere.           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
                    ▼                               ▼
┌───────────────────────────────────┐ ┌───────────────────────────────────┐
│                                   │ │                                   │
│   Step 2a: Implement for SERVER   │ │   Step 2b: Implement for CLIENT   │
│   ────────────────────────────    │ │   ────────────────────────────    │
│   definition.server(fn)           │ │   definition.client(fn)           │
│                                   │ │                                   │
│   Lives in server-side code.      │ │   Lives in client-side code.      │
│   Registered in chat().           │ │   Registered in useChat().        │
│                                   │ │                                   │
└───────────────────────────────────┘ └───────────────────────────────────┘
```

The clever part? The `.server()` and `.client()` methods are chained directly off the definition. This keeps the implementation co-located with its contract, even though they'll run in completely different environments.

## What This Looks Like in Code

### The Shared Definition

```typescript
// src/tools/definitions.ts
// This file is imported by BOTH server and client

import { toolDefinition } from '@tanstack/ai';
import { z } from 'zod';

export const searchRecordingsDef = toolDefinition({
	name: 'search_recordings',
	description: 'Search recordings by keyword',
	inputSchema: z.object({
		query: z.string().describe('Search query'),
	}),
	outputSchema: z.object({
		results: z.array(
			z.object({
				id: z.string(),
				title: z.string(),
				snippet: z.string(),
			}),
		),
	}),
});

export const showNotificationDef = toolDefinition({
	name: 'show_notification',
	description: 'Show a notification to the user',
	inputSchema: z.object({
		message: z.string(),
		type: z.enum(['success', 'error', 'info']),
	}),
	outputSchema: z.object({
		shown: z.boolean(),
	}),
});
```

Notice there's no implementation here. Just the contract: "this tool is called X, takes Y as input, returns Z."

### The Server Implementation

```typescript
// src/tools/server.ts
// This file only runs on the server

import { searchRecordingsDef } from './definitions';
import { db } from '../db';

export const searchRecordings = searchRecordingsDef.server(
	async ({ query }) => {
		// This runs on the server - full database access
		const results = await db.query(
			'SELECT id, title, snippet FROM recordings WHERE content LIKE ?',
			[`%${query}%`],
		);
		return { results };
	},
);
```

The `.server()` method takes your implementation function and returns a tool that's ready to be registered with `chat()`.

### The Client Implementation

```typescript
// src/tools/client.ts
// This file only runs in the browser

import { showNotificationDef } from './definitions';
import { clientTools } from '@tanstack/ai-client';
import { toast } from 'svelte-sonner';

const showNotification = showNotificationDef.client(({ message, type }) => {
	// This runs in the browser - can access DOM, browser APIs
	toast[type](message);
	return { shown: true };
});

export const myClientTools = clientTools([showNotification]);
```

The `.client()` method does the same thing, but for browser-side execution.

## Where Everything Gets Registered

Here's the key insight: server tools and client tools are registered in completely different places.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              SERVER                                         │
│                                                                             │
│   // src/routes/api/chat/+server.ts                                         │
│                                                                             │
│   import { chat, toServerSentEventsResponse } from '@tanstack/ai';          │
│   import { searchRecordings } from '../../tools/server';                    │
│                                                                             │
│   export async function POST({ request }) {                                 │
│     const { messages } = await request.json();                              │
│                                                                             │
│     const stream = chat({                                                   │
│       adapter: openaiText('gpt-4o'),                                        │
│       messages,                                                             │
│       tools: [searchRecordings],  // ◀── Server tools go here               │
│     });                                                                     │
│                                                                             │
│     return toServerSentEventsResponse(stream);                              │
│   }                                                                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER                                        │
│                                                                             │
│   // src/components/Chat.svelte                                             │
│                                                                             │
│   <script lang="ts">                                                        │
│     import { useChat, fetchServerSentEvents } from '@tanstack/ai-svelte';   │
│     import { myClientTools } from '../tools/client';                        │
│                                                                             │
│     const { messages, sendMessage } = useChat({                             │
│       connection: fetchServerSentEvents('/api/chat'),                       │
│       tools: myClientTools,  // ◀── Client tools go here                    │
│     });                                                                     │
│   </script>                                                                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## The Runtime Flow

When the LLM decides to call a tool, different things happen depending on whether it's a server or client tool:

```
User: "Search for my AI recordings and notify me when done"
                                    │
                                    ▼
                         LLM processes request
                                    │
        ┌───────────────────────────┴───────────────────────────┐
        │                                                       │
        ▼                                                       ▼
   tool_call:                                              tool_call:
   search_recordings                                       show_notification
        │                                                       │
        ▼                                                       ▼
┌───────────────────┐                                 ┌───────────────────┐
│ chat() checks:    │                                 │ chat() checks:    │
│ Has .server()?    │                                 │ Has .server()?    │
│       │           │                                 │       │           │
│      YES          │                                 │       NO          │
│       │           │                                 │       │           │
│       ▼           │                                 │       ▼           │
│ Execute here      │                                 │ Signal browser    │
│ in chat()         │                                 │ to execute        │
└───────────────────┘                                 └─────────┬─────────┘
        │                                                       │
        │                                                       ▼
        │                                             ┌───────────────────┐
        │                                             │ useChat() in      │
        │                                             │ browser executes  │
        │                                             │ .client() impl    │
        │                                             │                   │
        │                                             │ User sees toast!  │
        │                                             └─────────┬─────────┘
        │                                                       │
        └───────────────────────────┬───────────────────────────┘
                                    │
                                    ▼
                         Results back to LLM
                                    │
                                    ▼
                      LLM generates final response
```

## Why This Design?

You might wonder: why not just have two separate functions like `serverTool(definition, fn)` and `clientTool(definition, fn)`?

That would work, but the method chaining approach has a nice property: the implementation stays attached to its definition.

```typescript
// Method chaining (what TanStack AI does)
// The relationship is clear: this IS the server impl of searchRecordingsDef
const searchRecordings = searchRecordingsDef.server(async ({ query }) => {
	return { results: await db.search(query) };
});

// Alternative: separate functions (what they could have done)
// The relationship is less obvious; definition and impl are separate
const searchRecordings = serverTool(searchRecordingsDef, async ({ query }) => {
	return { results: await db.search(query) };
});
```

It's a small difference, but when you're scanning code trying to understand what tools exist and how they're implemented, that direct chaining makes the relationship immediately clear.

## The Full Picture

Here's how everything fits together:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         FILE STRUCTURE                                      │
└─────────────────────────────────────────────────────────────────────────────┘

src/
├── tools/
│   ├── definitions.ts      ◀── Shared contracts
│   │   │                       (toolDefinition calls)
│   │   │                       Imported by server AND client
│   │   │
│   │   ├─────────────────────────────────────────────┐
│   │   │                                             │
│   │   ▼                                             ▼
│   ├── server.ts           ◀── .server() impls   client.ts ◀── .client() impls
│   │   │                       (DB, APIs)            │          (UI, browser)
│   │   │                                             │
│   │   │                                             │
│   │   ▼                                             ▼
├── routes/api/chat/                              components/
│   └── +server.ts          ◀── chat()            └── Chat.svelte ◀── useChat()
│       registers server                              registers client
│       tools here                                    tools here


┌─────────────────────────────────────────────────────────────────────────────┐
│                         TYPE FLOW                                           │
└─────────────────────────────────────────────────────────────────────────────┘

  toolDefinition({ inputSchema: z.object({ query: z.string() }) })
                                    │
                                    │ TypeScript infers:
                                    │ Input = { query: string }
                                    │
            ┌───────────────────────┴───────────────────────┐
            │                                               │
            ▼                                               ▼
    .server(({ query }) => ...)                   .client(({ query }) => ...)
            │                                               │
            │ Type-safe! TypeScript knows                   │
            │ `query` is a string                           │
            │                                               │
```

## When to Use Each

The decision is straightforward:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Does the tool need...                                                     │
│                                                                             │
│   ┌─────────────────────────────┐    ┌─────────────────────────────┐        │
│   │ Database access?            │    │ Update the UI?              │        │
│   │ API keys / secrets?         │    │ Browser APIs?               │        │
│   │ Heavy computation?          │    │ User interaction?           │        │
│   │ File system access?         │    │ Clipboard / notifications?  │        │
│   └──────────────┬──────────────┘    └──────────────┬──────────────┘        │
│                  │                                  │                       │
│                  ▼                                  ▼                       │
│            Use .server()                      Use .client()                 │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

Most tools are one or the other. Pick based on what the tool needs access to.

## Summary

TanStack AI's tool pattern gives you:

1. **One source of truth** for the tool contract (the `toolDefinition`)
2. **Type safety** that flows from definition to implementation
3. **Clear separation** of where implementations live and run
4. **Flexibility** to implement the same contract differently on server vs client

The method chaining syntax (`.server()`, `.client()`) keeps implementations tied to their definitions while ensuring they run in the right environment. It's a small API surface that solves a real architectural problem.

The pattern works especially well in frameworks like SvelteKit where you have both server routes and client components in the same codebase. Define your contracts once, implement them where they need to run, and let the type system keep everything in sync.
