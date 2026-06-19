# Collapse cloud chat onto the in-process answerer: delete the server doc-generation vertical

**Date**: 2026-06-18
**Status**: Draft
**Owner**: Braden
**Implements**: [ADR-0021](../docs/adr/0021-a-conversation-has-one-transport-and-two-triggers.md) (revised) — withdraws [ADR-0022](../docs/adr/0022-the-cloud-doc-generation-queue-is-withdrawn.md)

## One Sentence

zhongwen becomes opensidian: a cloud conversation is answered **in the browser** by `attachChatBrowserAnswerer` sourcing tokens from the shared **Epicenter provider** (`/api/ai/chat` SSE, billed reserve→402→confirm in one request), so the entire server-side doc-generation vertical — `runDocGeneration`, the `/api/ai/chat/doc` route, and the half-built queue consumer — is **deleted**, leaving Epicenter cloud as a blind sync network plus a stateless metered inference stream that never writes a conversation doc.

## Why (the short version)

The grilling trail lives in ADR-0021 (revised) and ADR-0022 (withdrawn). The load-bearing facts, all verified in-repo:

- `runDocGeneration` (server hydrates a replica, forwards updates over `room.sync` RPC) has **one** production caller: the `/api/ai/chat/doc` route. The daemon (`attachChatWorker`) and the browser (`attachChatBrowserAnswerer`) write a **local** `Y.Doc` in-process and never use it.
- **opensidian already ships the target pattern** and tests it: `apps/opensidian/src/lib/chat/epicenter-provider.ts` (`createEpicenterProviderChatStream`) + `attachChatBrowserAnswerer` answer cloud conversations in the browser with no kickoff. `epicenter-provider.test.ts` proves it.
- The Epicenter provider has **no opensidian-specific deps** (`@epicenter/constants`, `@epicenter/workspace/ai`, `@tanstack/ai`, `wellcrafted`) → it promotes to a shared package cleanly.
- The synchronous-402 billing boundary already exists on `/api/ai/chat` (`chargeAiCreditsWithAutumn`). No kickoff, no queue, no cross-invocation finalize.

## Current State

- **zhongwen** (`apps/zhongwen/src/routes/(signed-in)/components/ConversationView.svelte`): cloud conversations call `nudgeBoundAgent()` → `kickoffGeneration()` → POST `API_ROUTES.ai.chatDoc` (the server kickoff), holding `kickoffController` open and feeding `externallyGenerating` into `chatRenderState`. `stop()` aborts the kickoff. `AgentConfig.runtime` is `'cloud' | 'daemon'`.
- **opensidian** (`apps/opensidian/src/lib/chat/`): the reference. `chat-state.svelte.ts` does `docHandle.answer(createEpicenterProviderChatStream({ fetch, url, data }))` — browser-answered, no trigger to OR in.
- **Server vertical to delete**: `packages/server/src/ai/doc-generation.ts` (+ `doc-generation.test.ts`, `worker-over-room-sync.test.ts`), the `/api/ai/chat/doc` route + body schema in `packages/server/src/routes/ai.ts` (+ its `ai.test.ts` cases), the `runDocGeneration` export (`packages/server/src/index.ts` / `ai/index.ts`), and `apps/api/worker/ai-generation-consumer.ts` (untracked WIP toward the withdrawn queue).
- **SSE endpoint** `/api/ai/chat` (`packages/server/src/routes/ai.ts`, billed by `chargeAiCreditsWithAutumn`): **kept, unchanged.** It is the metered inference stream the Epicenter provider calls.

## Implementation Plan

### Wave 1: Promote the Epicenter provider to a shared package — additive

- [x] **1.1** Move `createEpicenterProviderChatStream` (+ `EpicenterProviderData`) out of `apps/opensidian/src/lib/chat/epicenter-provider.ts` into a shared home next to `createAiChatFetch` (`@epicenter/client` is the natural fit; it already exports the auth fetch). Move the test with it.
  > **Landed** `18b0df48b` (`refactor(client): promote the Epicenter provider into @epicenter/client`). Exported from `@epicenter/client`; `EpicenterProviderData = { model, systemPrompts }`.
- [x] **1.2** Point opensidian at the shared export; delete the opensidian-local copy. Verify opensidian `svelte-check` + the moved test stay green.

### Wave 2: zhongwen answers cloud conversations in the browser — the rewire

- [x] **2.1** In `ConversationView.svelte`, for a cloud-runtime (non-resident) conversation, attach the in-process answerer over the conversation doc with the Epicenter provider as its `ChatStream`.
  > **Note (deviation from the opensidian reference):** opensidian's `docHandle.answer(...)` does **not** exist in the workspace yet (it is unimplemented WIP on this branch). zhongwen uses the real, shipped primitive directly: `attachChatBrowserAnswerer({ doc: docHandle.ydoc, startStream: createEpicenterProviderChatStream({ fetch: aiChatFetch, url: API_ROUTES.ai.chat.url(APP_URLS.API), data: () => ({ model: ZHONGWEN_MODEL, systemPrompts: [ZHONGWEN_SYSTEM_PROMPT] }) }) })`. `ChildDocHandle` exposes `ydoc` (`workspace.ts:176`), so no new handle method is needed. A future `docHandle.answer()` convenience is the separate authoring-surface "fold into `.open()`" collapse, not a Wave 2 dependency. A daemon-bound conversation attaches nothing.
- [x] **2.2** Delete `nudgeBoundAgent`, `kickoffGeneration`, `kickoffController`, the `externallyGenerating` OR-in, and the cloud branch of `stop()`. `send()` is one durable transcript write; the attached answerer claims the turn. A provider 402/network failure now lands as a `finish: failed` (the provider carries `InsufficientCredits` as the chunk code) and surfaces via `render.failure`, so the bespoke `toSendError`/`AiChatHttpError` plumbing is gone.
- [x] **2.3** Recharacterize `AgentConfig.runtime` semantics to "is this answered by a resident daemon?" The `'cloud' | 'daemon'` values are kept (still drive the fork); the routing comments in `zhongwen.ts` (the catalog file, not `agents.ts`), the `agents.test.ts` framing, and the README "How it works" are all rewritten off the kickoff onto the in-process answerer. `ConversationView` reads `agentConfig().runtime !== 'daemon'`.
- [x] Checkpoint: zhongwen `svelte-check` 0 errors, 0 warnings; `agents.test.ts` green. Commit.

### Wave 3: Delete the server doc-generation vertical — the break

- [x] **3.1** Removed the `/api/ai/chat/doc` route + `aiChatDocBody` + `DOC_GUID_REGEX` from `packages/server/src/routes/ai.ts`; `mountAiApp` mounts SSE only. The module docstring is rewritten to one transport.
  > No doc-route-specific `chargeAiCreditsWithAutumn` wrapping existed to drop: the policy is applied uniformly via `mountAiApp`'s `policies` and is unchanged.
- [x] **3.2** Deleted `packages/server/src/ai/doc-generation.ts`, `doc-generation.test.ts`, `worker-over-room-sync.test.ts`, and the `runDocGeneration` export (`packages/server/src/index.ts`; there was no `ai/index.ts`). Deleted the untracked `apps/api/worker/ai-generation-consumer.ts`, the worker `queue()` entrypoint, and the `queues` block in `wrangler.jsonc` (then `wrangler types` dropped the `AI_GENERATION_QUEUE` binding). Removed `API_ROUTES.ai.chatDoc` (no caller remained: zhongwen migrated in Wave 2).
  > `doName` and `createDurableObjectRooms` exports stay: they have other internal consumers (`rooms.ts`, `server-app.ts`), unrelated to the deleted vertical. `resolveAdapter` stays (the kept SSE route uses it).
- [x] **3.3** Dropped the doc-route cases from `packages/server/src/routes/ai.test.ts`. Rewrote the now-stale "kickoff is kept" docstrings in `chat-answer.ts`, `chat-worker.ts`, and `chat-browser-answerer.ts` onto the in-process answerer. `apps/api`/`apps/self-host` worker entries needed no change beyond removing the `queue()` handler.
- [x] Checkpoint: `packages/server` + `packages/constants` + `apps/api` + `packages/workspace` typecheck all clean (exit 0). Server tests: the AI route tests pass; the only 5 failures are pre-existing `requireBearerUser` failures in `require-auth.test.ts` (untouched by this work). No new `console.*` in library code.

### Wave 4: Verify + harvest

- [ ] **4.1** zhongwen cloud conversation answers end to end in the browser (direct SSE → local doc → syncs to a second device). A daemon-bound conversation still answers ambiently. One turn is never answered twice (the shared claim guard).
- [ ] **4.2** `post-implementation-review` on touched files.
- [ ] **4.3** ADR-0021 already revised; ADR-0022 already Superseded. Delete this spec (`git rm`). Run `bun run scripts/check-doc-hygiene.ts`.

## The refusals (do not drift)

| Refuse | Why |
| --- | --- |
| Any server-side doc writer for chat (`runDocGeneration`, a queue consumer, an in-DO generator) | the cloud is a metered inference stream; only in-process peers write the doc (ADR-0021/0017) |
| A kickoff / a separate cloud answerer | the Epicenter-provider SSE request is already the auth + 402 + metering boundary |
| Durable cloud answer without a daemon | durability is the daemon's job, free; the cloud answer is interactive (ADR-0021/0022) |
| Duplicating the Epicenter provider per app | promote it once; zhongwen and opensidian share one implementation |
| Touching `/api/ai/chat` (SSE) | it is kept verbatim as the inference stream |
| Adding chat code to the room DO | the relay stays blind (ADR-0017) |

## Success Criteria

- [ ] No server-side doc generation remains: `runDocGeneration`, `/api/ai/chat/doc`, and the queue consumer are deleted; `mountAiApp` mounts SSE only; nothing in `packages/server` request handlers reads conversation semantics.
- [ ] zhongwen answers a cloud conversation in the browser via the shared Epicenter provider; the user message echoes instantly and the assistant streams directly from `/api/ai/chat` into the synced doc; a second device sees it via sync.
- [ ] The daemon path (`attachChatWorker`) is untouched and still answers ambiently; one turn is never answered twice across a browser and a daemon.
- [ ] "Out of credits" still returns a synchronous 402 on `/api/ai/chat`; billing reserves and confirms in that one request (no queue, no finalize dance).
- [ ] Self-host mounts SSE only and is free; the `personal()` / `shared({ admit })` seam is untouched.
- [ ] `bun test` green in touched packages; `svelte-check` 0 errors for touched apps; typecheck clean; no `console.*` in library code.

## References

- `apps/opensidian/src/lib/chat/epicenter-provider.ts` + `chat-state.svelte.ts` — the working reference pattern to generalize
- `packages/workspace/src/ai/chat-browser-answerer.ts` — the in-process answerer (drop its "browser does NOT run for cloud-runtime" caveat in the docstring)
- `packages/workspace/src/ai/chat-worker.ts` — the shared answer loop + claim guard (unchanged)
- `packages/server/src/routes/ai.ts` — keep SSE, delete the doc route
- `packages/server/src/ai/doc-generation.ts` — deleted (its only caller was the doc route)
- `apps/zhongwen/src/routes/(signed-in)/components/ConversationView.svelte`, `apps/zhongwen/src/agents.ts` — the rewire
