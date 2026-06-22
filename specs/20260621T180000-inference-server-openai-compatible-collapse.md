# Inference server + OpenAI-compatible contract collapse

- **Status:** Draft
- **Date:** 2026-06-21
- **Decisions:** [ADR-0049](../docs/adr/0049-inference-is-its-own-box-the-daemon-never-infers.md) (inference is its own box; the daemon never infers; the client loop talks to a swappable inference server), [ADR-0050](../docs/adr/0050-the-inference-contract-is-openai-compatible.md) (the inference contract is OpenAI-compatible Chat Completions; Epicenter's backend is one swappable gateway)
- **Builds on:** [ADR-0047](../docs/adr/0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) (client loop, dispatched tools), [ADR-0048](../docs/adr/0048-a-conversations-loop-is-chosen-by-whether-its-transcript-syncs.md) (two-loop boundary)
- **Supersedes on landing:** [ADR-0037](../docs/adr/0037-adapter-construction-is-a-shared-leaf-package-keyed-on-the-model-catalog.md), [ADR-0038](../docs/adr/0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md)

This is in-flight scaffolding. When the work lands: flip ADR-0049/0050 to `Accepted`, add reciprocal `Superseded by` headers to ADR-0037/0038, and delete this spec.

## Goal

Make inference a single, swappable box that speaks the OpenAI-compatible Chat Completions API, and remove the daemon-side inference arm. The client agent loop drives one inference server chosen by base URL: Epicenter's metered gateway, a self-hosted gateway, or any third-party OpenAI-compatible endpoint (Ollama, vLLM, OpenRouter). The daemon holds data and runs dispatched tools only; it never infers.

The product driver is swappability: changing the inference backend should be configuration (`baseURL` + auth), not per-backend adapter code. That is free under an OpenAI-compatible contract and expensive under the current bespoke AG-UI contract.

## Current state (what exists today)

- **Client engine** (`packages/client/src/epicenter-provider.ts`): `createEpicenterAgentEngine` posts to `/api/ai/chat`, hand-parses an AG-UI `StreamChunk` SSE stream, forwards tool definitions (`:190-195`).
- **Consumers:** `apps/vocab/epicenter-engine.ts` and opensidian's chat-state both use this metered engine. Both live consumers already answer through the server (no daemon inference).
- **Server route** (`packages/server/src/routes/ai.ts:147-155`): runs TanStack `chat({ adapter, messages, tools })` + `toServerSentEventsResponse()`. Tools have no server `execute`, so `chat()` emits the tool calls and stops; the client loop executes them.
- **Provider normalization** (`packages/ai-adapters/src/index.ts`): `createAdapterForModel` (TanStack openai/gemini adapters), `chatStreamFromAdapter` (the daemon BYOK arm, ADR-0038).
- **Loop:** `packages/workspace/src/agent/loop.ts` + `message.ts` import `@tanstack/ai` types (`EventType`, `StreamChunk`, `ModelMessage`, `ToolCall`).
- **Dead-on-paper:** the daemon inference arm (`chatStreamFromAdapter`, the daemon `resolveChatStream`) contradicts ADR-0047 and is unused by both live consumers.

## Target state

```
CLIENT loop ──(OpenAI /v1/chat/completions, configurable baseURL + auth)──▶ inference server
  parses OpenAI SSE deltas into its own small chunk type                    Epicenter gateway (auth + meter + BYOK passthrough; OpenAI passthru, Gemini normalized)
  executes tool_calls -> local action or dispatched to a daemon             self-hosted gateway (your key or local model, unmetered)
  no @tanstack/ai                                                           Ollama / vLLM / OpenRouter
```

Privacy gradient the box model gives users: **metered** (house key, Epicenter pays), then **BYOK-passthrough** (your key via Epicenter, unmetered, key seen in transit only), then **self-hosted/local** (key never touches Epicenter).

## The contract

OpenAI-compatible Chat Completions, streamed:
- Request: `POST /v1/chat/completions` with `{ model, messages, tools?, stream: true, stream_options: { include_usage: true } }`.
- Stream of `chat.completion.chunk` SSE: `choices[].delta.content` (text) and `choices[].delta.tool_calls[]` (index-correlated; `id`, `function.name`, `function.arguments` deltas). Terminal `finish_reason` of `tool_calls`, `stop`, etc. A final usage-bearing chunk when `include_usage` is set.
- The server returns tool calls and stops; it never executes a tool.

## Waves

### Wave 0: decisions as docs (this PR)
- ADR-0049, ADR-0050 (`Proposed`), CONTEXT glossary (Node roles, Inference server). Done in this branch.

### Wave 1: Gemini-over-OpenAI-compatible spike (GATE)
Verify Google's OpenAI-compatible endpoint (`/v1beta/openai/`) streams **tool calls** faithfully: index correlation, partial-argument accumulation, and that Gemini's thought-signature-in-tool-call-id behavior does not corrupt the OpenAI shape. Throwaway spike.
- If faithful: gateway does passthrough to Google's compat endpoint.
- If not: the gateway owns a thin Gemini-native to OpenAI-compatible stream translator (server-side; client unaffected).
- Blocks committing Gemini only; OpenAI works regardless.

### Wave 2: client OpenAI-compatible engine
- New `AgentEngine` that speaks `/v1/chat/completions` SSE: build the request (messages to OpenAI messages incl. system role from `systemPrompts`; tools to OpenAI `tools`), parse text + index-correlated `tool_call` deltas, map `finish_reason`.
- Define a small internal chunk/event type in `packages/workspace/src/agent` to replace `@tanstack/ai`'s `EventType`/`StreamChunk`/`ModelMessage`/`ToolCall` in `loop.ts` and `message.ts`. The loop's `runStep` reducer keeps its shape; only the event vocabulary becomes local.
- Engine takes a configurable `baseURL` + auth header. Default points at the Epicenter gateway.
- Coexist with the current AG-UI engine behind config until Wave 5.

### Wave 3: Epicenter OpenAI-compatible gateway
- `/v1/chat/completions` route: bearer auth, then credit check (Autumn) + house-key injection, OR **BYOK passthrough** (user key in `Authorization`, skip metering), then upstream OpenAI (passthrough) / Gemini (compat or translator per Wave 1), stream back, meter from `usage`.
- App-error convention in OpenAI shape: `InsufficientCredits` as HTTP 402 + `error.code`; `Unauthorized` as 401; a mid-stream failure as an error chunk. Document it.
- Billing stays hosted-only (`apps/api/worker/billing/`); the route lives in `packages/server` so a self-hosted deployable can mount it without billing.

### Wave 4: swap config + self-host
- Expose "inference server URL + auth" as client config (default Epicenter gateway; allow Ollama/OpenRouter/self-hosted URL).
- Self-hostable gateway deployable = the gateway route minus billing (a thin wrapper over the `packages/server` AI sub-app).

### Wave 5: delete the old path
- Remove the AG-UI `createEpicenterAgentEngine` + its SSE-frame parser, the server's TanStack `chat()` usage, the daemon inference arm (`chatStreamFromAdapter`, daemon `resolveChatStream`), and `@tanstack/ai` from `packages/workspace` + `packages/client` + the `ai-adapters` inference path.
- Flip ADR-0049/0050 to `Accepted`; add `Superseded by` to ADR-0037/0038; delete this spec.

## Out of scope (do not touch)

- **tab-manager** keeps its `@tanstack/ai-svelte` / `@tanstack/ai-client` device-local loop (ADR-0048). Do not remove its TanStack deps. It may converge on the new engine later, but is not forced to.
- Advanced features (reasoning traces, prompt caching, citations). They ride a `provider_specific_fields`-style extension slot when needed; not now.
- A third-party gateway (LiteLLM/OpenRouter) as the normalizer. Unnecessary for two OpenAI-compatible providers; the contract makes either a drop-in upstream later.

## Open questions

1. **Gemini streamed tool-call fidelity** (Wave 1 gate): passthrough vs thin translator.
2. **Self-hosted gateway packaging**: a new `apps/inference-server` deployable, or a documented standalone mount of the `packages/server` AI sub-app? Decide in Wave 4.
3. **Loop chunk type**: exact shape of the internal event type replacing `@tanstack/ai`'s; keep it minimal (text-delta, tool-call-start/args/end, run-error, run-finished).

## Done criteria

- The client loop drives inference over the OpenAI-compatible contract; `@tanstack/ai` is gone from the workspace + client inference path.
- Changing the inference backend is configuration only (proven by pointing at a local Ollama).
- The daemon runs no inference; `chatStreamFromAdapter` and the daemon answerer are deleted.
- Metering still works (usage-based) on the Epicenter gateway; BYOK passthrough skips metering.
- Build green; doc-hygiene clean; ADRs flipped and spec deleted.

## Sequencing vs other work

- **PR #2157** (agent-loop predicate fix + ADR-0048 + CONTEXT reconcile) lands first; this branch stacks on it because the CONTEXT edits build on #2157's reconcile. After #2157 merges, rebase this onto `main`.
- Wave 1 (Gemini spike) is the first execution step and gates Gemini only.
