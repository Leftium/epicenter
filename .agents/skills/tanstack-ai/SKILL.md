---
name: tanstack-ai
description: TanStack AI patterns for @tanstack/ai, @tanstack/ai-svelte, chat state, streamed responses, UIMessage parts, tool calling, tool approvals, and provider model adapters. Use when working on AI chat, createChat, fetchServerSentEvents, UIMessage conversion, or TanStack AI tools.
metadata:
  author: epicenter
  version: '1.0'
---

# TanStack AI

## Reference Repositories

- [TanStack AI](https://github.com/tanstack/ai) - Framework and adapters for AI chat, streaming, tools, and provider integrations

## Upstream Grounding

When TanStack AI behavior, `createChat`, streamed message parts, tool calling, approvals, provider adapters, or Svelte bindings affect correctness, ask DeepWiki a narrow question against `tanstack/ai` before relying on memory. Use it to orient, then verify decisive details against local installed types, source, or official docs before changing code.

Skip DeepWiki for repo-local chat persistence and UI patterns already visible in the app.

## When to Apply This Skill

Use this pattern when you need to:

- Build or refactor chat state based on `createChat`.
- Convert persisted workspace messages to or from TanStack AI `UIMessage` values.
- Render `MessagePart`, tool-call, or tool-result parts.
- Bridge workspace actions into TanStack AI tools.
- Debug streamed responses, reload behavior, stop behavior, or tool approvals.

## Local Anchors

- `apps/opensidian/src/lib/chat/chat-state.svelte.ts` shows Svelte chat state, persistence, streaming, and tool approval handling.
- `apps/opensidian/src/lib/chat/ui-message.ts` owns the persisted-message to TanStack-message boundary.
- `packages/workspace/src/ai/tool-bridge.ts` converts workspace actions into client tools and serializable server tool definitions.
