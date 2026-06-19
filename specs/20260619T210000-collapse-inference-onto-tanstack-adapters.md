# Collapse inference onto TanStack's own adapters: one ChatStream waist, two grounded builders

**Date**: 2026-06-19
**Status**: Draft
**Owner**: Braden
**Implements**: [ADR-0033](../docs/adr/0033-a-conversation-has-one-transport-and-two-triggers.md) — refines *how* the one `ChatStream` contract is constructed; no product-contract change.

> **Base / sequencing (recalibrated 2026-06-19).** This spec is **orthogonal in substance** to the in-flight `actor`/`reaction` → **`worker`** vocabulary reconciliation (branch `feat/conversation-worker`), but it **stacks on top of it** — do not start until that lineage settles. Two parallel lineages named one concept differently (`attachChatActor` on main's #2077 stack; `attachChatReaction` on the evolved conversation branch); the reconciliation renames both to `worker`. The `ChatStream` + `streamAnswer` **waist this spec depends on is preserved** by that merge. When implementing, first rebase onto the settled worker base, then mechanically map the names below: `chat-reaction.ts → chat-worker.ts`, `attachChatReaction → attachChatWorker` (the daemon-side answerer in Wave 2's `mount.ts` consumer). Waves 1 (new `@epicenter/ai-adapters` pkg + server `resolveAdapter`) and 3 (`epicenter-provider.ts`) carry **no** `reaction`/`actor`/`worker` naming, but still touch files the reconciliation reshapes (`routes/ai.ts` doc-gen deletion, the provider's promotion into `@epicenter/client`), so they wait too. "Settled" = evolved waist ported to `worker` + doc-gen vertical deleted + ADRs renumbered (keep 0024/0025, place 0021/0022) + fold rebased + PR #2112 repointed + 4 typechecks/workspace tests green + zero surviving `actor`/`reaction` references for this concept.

## One Sentence

Every inference source necks down to one `ChatStream` waist, and each side is built from the matching **TanStack** primitive: in-process callers wrap `chat({ adapter })` over a single shared `createAdapterForModel` (a new leaf package `@epicenter/ai-adapters`), and the browser's cloud path consumes its SSE through TanStack's own `fetchServerSentEvents`, deleting the hand-rolled wire parser while keeping the structured-error catch intact.

## Why (the short version)

Grounded against `TanStack/ai` via DeepWiki (`@tanstack/ai` is pinned at **0.28.0**), three facts settle the shape:

1. **There is no single TanStack interface that both a text adapter and a connection adapter satisfy.** `chat()` is the *server layer* (text adapters → `AsyncIterable<StreamChunk>`); `ConnectConnectionAdapter.connect(messages, data?, signal?)` is the *client layer* (transport). They are different layers on purpose. So the unifier is **ours**: `ChatStream` (`(messages, signal) => AsyncIterable<StreamChunk>`), the narrow waist both layers neck down to. We do **not** try to replace `ChatStream` with a TanStack type — there isn't one.
2. **`fetchServerSentEvents` (in `@tanstack/ai-client`, framework-agnostic) is exactly the consumer for a `toServerSentEventsResponse()` endpoint.** Our `epicenter-provider.ts` hand-rolls `parseServerSentEvents` (~35 lines) and carries a comment — *"TanStack does not expose its SSE connection parser as a standalone utility"* — that is **false** at 0.28.0. The hand-roll is a second reader of TanStack's own wire format.
3. **The model → provider adapter construction has two production owners.** `resolveAdapter` (`packages/server/src/routes/ai.ts:92`, openai|gemini, BYOK ?? house) is re-implemented gemini-only in the daemon (`apps/zhongwen/mount.ts:102`). (A third copy lives in `examples/doc-as-wire-chat/src/inference.ts`; it is **deliberately standalone** for teaching — "swap real inference in is this one function" — and is left alone.) The model catalog (`MODELS_BY_ID`) is single-owned in `@epicenter/constants/ai-providers`; the *construction* of an adapter from a model is its executable twin.

**Error mapping needs no upstream feature (corrected).** `createAiChatFetch` (`packages/client/src/ai-chat-fetch.ts:74`) already *throws* a structured `AiChatHttpError` on a non-2xx response. Because the browser path calls `connect()` directly (it does **not** use `ChatClient`), that throw lands in our own `ChatStream` loop, where the existing `instanceof AiChatHttpError` catch maps it to a `RUN_ERROR` chunk. So the out-of-credits → retryable doc-failure path is preserved by *our* catch, independent of `RUN_ERROR.rawEvent` or any `@tanstack/ai` version floor. `fetchServerSentEvents` still clears the other gates (verified): custom authed fetch via `fetchClient`, and per-call `data` forwarded into the POST body so the mid-conversation model switch survives without rebuilding the adapter.

## What we deliberately do NOT collapse

- **Local vs remote stays one visible branch, not one merged path.** The remote arm spends credits and needs a session; the local arm does not. That asymmetry is real product behavior. TanStack's layer split keeps it legible for free: local is an `AnyTextAdapter`, remote is a `ConnectConnectionAdapter`. Keep the branch in the daemon's resolver; do not invent a single "source" factory that hides which one costs money.
- **The waist is ours.** `ChatStream` earns its keep precisely as the adapter between TanStack's two worlds and the doc sink (`streamAnswer`). It is not slop to be replaced by a provider type.
- **The `chat({ adapter })` wrapper stays inline in the daemon** (one in-process caller). Do not extract a `chatStreamFromAdapter` helper for a single consumer; that is the premature shared-helper greenfield warns against. Revisit only when a second in-process adapter caller appears (e.g. browser BYOK).

## Current State

- **Waist (sink):** `packages/workspace/src/ai/chat-answer.ts` — `ChatStream` + `streamAnswer`. Backend-agnostic; depends on `@tanstack/ai` core only (no provider packages). Unchanged by this spec.
- **Server route:** `packages/server/src/routes/ai.ts` — `resolveAdapter` (the canonical switch) + the `/api/ai/chat` handler calling `chat()` → `toServerSentEventsResponse`. Imports `@tanstack/ai-gemini` + `@tanstack/ai-openai` directly.
- **Daemon:** `apps/zhongwen/mount.ts:92` `resolveChatStream` — gemini-only inline switch (`createGeminiChat(ZHONGWEN_MODEL, GEMINI_API_KEY)`), wraps `chat()` into a `ChatStream`, falls back to `fakeChatStream`. Depends on `@tanstack/ai-gemini` (no `-openai`).
- **Browser cloud path:** `packages/client/src/epicenter-provider.ts` — `createEpicenterProviderChatStream` (bespoke `fetch` + hand-rolled `parseServerSentEvents`) + `EpicenterProviderData`. Test: `epicenter-provider.test.ts`. Depends on `@tanstack/ai` core only.
- **Dependency graph (verified):** `packages/server` and `apps/zhongwen` both depend on `@epicenter/constants`; neither client nor server depends on the other. `@epicenter/constants` is subpath-exported (`./ai-providers`, `./api-routes`, `./ai-chat-errors`) and owns `MODELS_BY_ID`. `@tanstack/ai-client` is already in the catalog (used by opensidian + tab-manager).

## Implementation Plan

Waves 1–2 (server + daemon construction) are independent of Wave 3 (browser transport). Each wave is independently green and revertible. Separate branch + commit per wave; do not batch.

### Wave 1: One shared adapter constructor in a new leaf package — additive

> **Home decision (greenfield, verified).** The construction must carry a *runtime* `createGeminiChat`/`createOpenaiChat` import. The browser imports `@epicenter/constants/ai-providers` at **6+ surfaces** (opensidian / zhongwen / tab-manager model pickers, api/ui `ModelCostGuide` + `ActivityFeed`), so putting construction in `ai-providers.ts` would risk pulling the provider SDKs into every browser bundle. A `constants/ai-adapters` subpath would isolate the bundle but make the SDKs a runtime dependency of the most-imported package in the repo. A **new leaf package** keeps `@epicenter/constants` pure (SDK stays a type-only devDep, unchanged) and isolates the SDK runtime weight to a leaf only `server` + `daemon` import. DAG: `constants/ai-providers (data) ← @epicenter/ai-adapters (construction) ← {server, daemon}`. Browser never touches `ai-adapters` → zero provider SDK in any browser bundle, deterministically (no reliance on third-party `sideEffects` flags).

- [x] **1.1** Scaffold `@epicenter/ai-adapters` (`packages/ai-adapters/`): `package.json` (deps: `@epicenter/constants`, `@tanstack/ai`, `@tanstack/ai-gemini`, `@tanstack/ai-openai` — all catalog), `tsconfig`, single `src/index.ts`:
  ```ts
  export function createAdapterForModel(model: ServableModel, apiKey: string): AnyTextAdapter {
    const entry = MODELS_BY_ID[model];
    switch (entry.provider) {
      case 'openai': return createOpenaiChat(entry.id, apiKey);
      case 'gemini': return createGeminiChat(entry.id, apiKey);
      default: return entry satisfies never;
    }
  }
  ```
  Body is **only** the provider switch + construction — no key policy, no `Result`. (`AnyTextAdapter` is already exported from `@tanstack/ai` and used by `resolveAdapter` today.)
- [x] **1.2** Rewrite `resolveAdapter` in `packages/server/src/routes/ai.ts` to keep its key policy (`userApiKey ?? env.X_API_KEY`, `ProviderNotConfigured` on no key) but delegate construction to `createAdapterForModel`. Drop the direct `createGeminiChat`/`createOpenaiChat` imports from the route and the two provider-SDK deps from `packages/server/package.json` (now owned by `@epicenter/ai-adapters`). Add `@epicenter/ai-adapters` as a server dep.
  > **Note**: key policy kept as an exhaustive `switch` selecting the per-provider house key (`OPENAI_API_KEY`/`GEMINI_API_KEY`), preserving `satisfies never`; construction delegated. Two switches on different concerns (policy in the route, construction in the leaf), as designed.
- [x] Checkpoint: `bun run --filter @epicenter/server typecheck`; `ai.test.ts` green (the `ProviderNotConfigured` and adapter-resolution cases are unchanged behavior). Commit. — green: ai-adapters + server typecheck pass, ai.test.ts 6/6.

### Wave 2: Daemon hot-swaps any provider through the shared switch — the rewire

- [x] **2.1** Rewrite `resolveChatStream` in `apps/zhongwen/mount.ts` to source its adapter from `createAdapterForModel`, keyed on the catalog provider of the configured model rather than hardcoding gemini: look up `MODELS_BY_ID[ZHONGWEN_MODEL].provider`, read the matching `process.env` key, and on a present key build `chat({ adapter: createAdapterForModel(ZHONGWEN_MODEL, key), systemPrompts: [ZHONGWEN_SYSTEM_PROMPT], abortController })` (the signal→abortController wiring stays inline, unchanged — single in-process caller, do not extract). No key → `fakeChatStream`, with the same log line generalized off "GEMINI_API_KEY" to "the configured provider's key".
- [x] **2.2** Replace the direct `@tanstack/ai-gemini` dep in `apps/zhongwen/package.json` with `@epicenter/ai-adapters`. The daemon now answers as whatever provider its `ZHONGWEN_MODEL` names; switching to an openai model is a catalog + env-key change, no code edit.
  > **Note**: also generalized the `fakeChatStream` placeholder text off the hardcoded `GEMINI_API_KEY` so the "no code edit to switch provider" property holds for the no-key path too. Env-key selection is an exhaustive `switch` (new provider = compile error, not a silent wrong key).
- [x] Checkpoint: `bun run --filter @epicenter/zhongwen typecheck`; daemon smoke (no key → `fakeChatStream`; gemini key → real reply) per ADR-0033 Part 1 step 1. Commit. — typecheck green (0 errors); live daemon smoke not run here (needs a provider key + cloud sync), same standing gap as the cloud-path smoke.

> **Deferred (explicit trigger):** "daemon signs into the cloud" — a third arm of `resolveChatStream` that reuses the browser's `fetchServerSentEvents` builder (Wave 3) so a keyless daemon answers via the metered `/api/ai/chat` on the user's account. Out of scope here because it needs a **headless daemon cloud identity** (an authenticated fetch a Node process can hold), which does not exist yet. Revisit when the daemon already holds a cloud credential for its sync connection — at that point this is "pass the same authed fetch to the cloud builder," no new machinery. Re-grounds against [[epicenter_cloud_kickoff_to_queue]].

### Wave 3: Browser cloud path consumes SSE through TanStack — the break

The win here is **deleting the hand-rolled wire reader**, not deleting the whole bespoke `ChatStream`. The structured-error catch stays, because `createAiChatFetch` throws `AiChatHttpError` and we sink `connect()` directly (no `ChatClient` to synthesize a `RUN_ERROR` for us). This is more robust than relying on `rawEvent` and removes the version-floor concern entirely.

- [ ] **3.1** Add `@tanstack/ai-client` (catalog) to `packages/client/package.json`. In `epicenter-provider.ts`, build `const conn = fetchServerSentEvents(API_ROUTES.ai.chat.url(...), { fetchClient: <the authed fetch> })` once, then return a `ChatStream` that `yield*`s `conn.connect(messages, data(), signal)` inside a `try`. The per-turn `data()` thunk (model + systemPrompts) flows through `connect`'s `data` arg into the POST body — the mid-conversation model switch is preserved by construction.
- [ ] **3.2** Delete `parseServerSentEvents` (~35 lines) and the false comment. **Keep** the `catch`: `if (signal.aborted) return; if (error instanceof AiChatHttpError) yield runErrorChunk(error.detail.name, error.detail.message); else yield runErrorChunk('stream-error', extractErrorMessage(error))`. Same mapping as today, now wrapping `conn.connect` instead of a hand-rolled fetch.
- [ ] **3.3** **Validation checkpoint (the one behavioral risk):** confirm a 402 makes `createAiChatFetch` throw *through* `fetchServerSentEvents.connect()` on first pull (so our `catch` sees `AiChatHttpError`, not a swallowed generic). Extend `epicenter-provider.test.ts`: (a) a normal stream yields the same chunks via `connect`; (b) a 402 yields a `RUN_ERROR` carrying `InsufficientCredits`, not a throw and not a generic `stream-error`. If `fetchServerSentEvents` swallows or wraps the `fetchClient` throw before it reaches us, fall back to passing a plain `fetch` and reading the non-2xx `Response` ourselves inside `connect`'s wrapper — still deleting the SSE framing.
- [ ] Checkpoint: `bun run --filter @epicenter/client typecheck`; `epicenter-provider.test.ts` green; `bun run --filter @epicenter/zhongwen typecheck` (consumer); cloud smoke per ADR-0033 Part 1 (funded → streams into doc; out of credits → `render.failure` + Retry). Commit.

> **De-risk option:** prototype 3.3's throw-through-`connect()` timing in a throwaway test against a stub 402 endpoint before deleting `parseServerSentEvents`. If the throw doesn't surface cleanly, the plain-`fetch` fallback in 3.3 still lands the parser deletion. Waves 1–2 stand alone regardless.

## Greenfield findings — boundaries examined, decisions recorded

- **`createAdapterForModel` home → new package, not constants.** See Wave 1 home decision. Verified: browser imports `constants/ai-providers` at 6+ surfaces, so a runtime SDK import there leaks into browser bundles; a `constants/ai-adapters` subpath would pollute the universal package's runtime dep graph. New leaf package keeps the DAG clean and constants pure.
- **Do NOT expand `AiChatHttpError`; contract it.** It is already a rich discriminated union. Three variants — `GenerationAlreadyExists`, `GenerationInProgress`, `NoUserMessage` — are **dead** (0 uses; they served the kickoff vertical ADR-0033 deleted). Delete them + their `AiChatErrorStatus` 409 rows **on `feat/cloud-kickoff-to-queue`** (the branch that made them dead), not in this spec — keep the deletion cohesive with its cause.
- **The doc-failure path flattens the error** (`runErrorChunk(detail.name, detail.message)` drops `balance`/`model`/`credits`). Nothing reads those today, so it is lossless in practice. **Do not** enrich the doc-stored failure until a UI earns it. Trigger to revisit: a failed-turn UI that wants a balance/upgrade CTA.
- **Daemon error taxonomy stays opaque for now.** `AiChatHttpError` is HTTP-transport-specific and does not apply to the BYOK daemon; a structured provider-error taxonomy (bad key, rate-limit) is a separate future. Trigger: daemon UX must distinguish failure causes.
- **`examples/doc-as-wire-chat/src/inference.ts` is left standalone.** Its duplicate `createGeminiChat` is deliberate pedagogy ("swap real inference in is this one function"); importing the shared package would defeat the zero-dep teaching value.
- **Request-body shape duplication** (`EpicenterProviderData` ⊂ server `aiChatBody`) is an intentional subset; the server is the permissive superset. Left as-is.

## Invariants (hold throughout)

- The cloud never writes a conversation doc; only an in-process peer does. This spec touches only *how tokens are sourced*, never the writer.
- `ChatStream` stays the single sink-facing contract; `streamAnswer` is untouched.
- Local (text adapter) vs remote (connection adapter) remains exactly one branch in the daemon resolver — the billing/auth seam stays visible.
- Existence-is-the-claim (`findUnansweredTurn`) remains the only double-answer guard.

## Verify Commands

```
bun run --filter @epicenter/ai-adapters typecheck
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/client typecheck
bun run --filter @epicenter/zhongwen typecheck
(cd packages/workspace && bun test)
bun run --filter @epicenter/client test    # epicenter-provider.test.ts
bunx biome check <changed .ts files>       # biome skips .svelte; run before pushing
```

## Post-landing

If the TanStack-grounded construction proves durable (it likely will — it deletes a hand-rolled wire reader and a duplicate switch), capture it as a short ADR refining ADR-0033's construction note, then delete this spec per the two-state lifecycle. Until then it stays `Draft`/`In Progress` in-tree.
