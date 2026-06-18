# One conversation core: loop and doc-sink

**Date**: 2026-06-18
**Status**: Draft
**Owner**: Braden
**Branch**: (to start) `feat/conversation-core`
**Implements**: [ADR-0021](../docs/adr/0021-a-conversation-has-one-transport-and-two-triggers.md)
**Relates**: [ADR-0020](../docs/adr/0020-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) (the parts body the core writes), [ADR-0019](../docs/adr/0019-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) (the regions a reply lives in), [ADR-0018](../docs/adr/0018-agents-are-immutable-capability-bundles.md) (tools are the agent's bundle), [ADR-0010](../docs/adr/0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (a tool is an action), [ADR-0014](../docs/adr/0014-an-always-on-reaction-runs-app-semantics-beside-the-app-blind-anchor.md)/[0015](../docs/adr/0015-agent-conversations-are-durable-child-docs-answered-by-reactions.md) (reactions)
**Parent buildout**: `specs/20260616T225034-reactions-buildout.tracker.md`
**Supersedes the forward half of**: `specs/20260618T100631-chat-transcript-parts-body.md` (its Phase 1+2 landed; this spec carries its Phase 3+4 and corrects the C4 premise, see below)

## One Sentence

Every answerer in every runtime runs one shared answer core (the inference loop that sinks parts into the conversation doc); runtimes differ only in how they are triggered, where inference runs, and which tools they can execute, and the second conversation-state owner (the browser's `createChat`-as-truth) is deleted while the inference endpoint stays as a metered backend.

## How to read this spec

```txt
Read first:
  One Sentence
  Current State
  Target Shape
  The runtime matrix
  Implementation Plan
  Success Criteria

Read if challenging the design:
  Why one core (the duplication today)
  The C4 correction
  Greenfield scope
  Open Questions

Scope boundary:
  This is the TRANSPORT + GENERATION collapse (ADR-0021). The BODY is already
  one shape (ADR-0020, landed). The ENVELOPE addressing (ADR-0019) is still
  deferred and is NOT this spec. The floor of the collapse is the trigger fork:
  the cloud kickoff is kept, never deleted (ADR-0021's B2 refusal).
```

## Motivation

### Current State

An answer is produced three ways, forked along two seams at once:

- **SSE route** (`packages/server/src/routes/ai.ts:157`): `/api/ai/chat` streams tokens over an open HTTP connection; the browser holds the conversation in TanStack `createChat` in-memory state and persists rows on `onFinish` (opensidian `chat-state.svelte.ts`, tab-manager `chat-state.svelte.ts`).
- **Cloud doc kickoff** (`ai.ts:193` -> `packages/server/src/ai/doc-generation.ts`): `/api/ai/chat/doc` hydrates the room replica, appends the assistant message, streams provider deltas into its `Y.Text`, forwards `updateV2` via `room.sync`, writes `finish`.
- **Daemon observer** (`packages/workspace/src/ai/chat-reaction.ts`): `attachChatReaction` observes the doc, claims the unanswered turn, streams deltas into the same writer, writes `finish`. No HTTP.

The flush-into-writer loop is **copied** in `chat-reaction.ts` (`streamReply`) and `doc-generation.ts` (the inline `for await` loop): same buffer, same `FLUSH_INTERVAL_MS`/`FLUSH_MAX_CHARS`, same finish-with-tail. `chat-reaction.ts:46` even documents the duplication as deliberate-until-deleted. That comment encodes the old plan (delete the HTTP path); ADR-0021 reverses it (keep the kickoff, delete SSE), so the duplication should be resolved by **extraction**, not deletion.

### Desired State

One answer core, three trigger wrappers, one transport:

```txt
core (runtime-agnostic):
  streamAnswer({ writer, startStream, prompt, signal, tools? })
    text delta      -> writer.appendText  (flush-batched: 75ms / 512 chars)
    tool-call chunk -> writer.appendToolCall; dispatch the action; writer.appendToolResult; continue   [Phase B]
    end / error     -> writer.finish(completed | failed)
    abort           -> no finish (cancel/teardown owns the terminal write)

trigger wrappers (per runtime):
  daemon  attachChatReaction   onChange -> claim -> streamAnswer        ambient, free
  cloud   runDocGeneration     kickoff  -> validate + reserve -> claim -> streamAnswer -> reconcile   billed
  browser (new, Phase C)       user send -> claim in local doc -> streamAnswer (TanStack chat + browser tools)   in-process, free

transport: the synced doc. The client always renders the doc. SSE deleted.
```

zhongwen is the byte-identical tracer through Phase A (text-only, exercised on *both* the cloud kickoff and the daemon). One SSE app (opensidian or tab-manager) is the render-from-doc tracer in Phase C.

## The runtime matrix

A "runtime" is not a hardcoded enum; it is three orthogonal axes. "Cloud" is just one corner of the cube (ADR-0021): hosted location + kickoff trigger + an injected billing policy. Pulling the axes apart is the deeper collapse and answers "can a self-hoster have a billed box" (yes: inject a policy).

| Runtime | Loop runs in | Trigger | Inference backend | Tools execute | Billed |
| --- | --- | --- | --- | --- | --- |
| Cloud | hosted Durable Object | **kickoff** (authed POST) | house key (metered) | cloud-safe tools only; a remote tool is a relay round-trip | yes (the house key) |
| Self-host daemon | the user's daemon process | **ambient** (sync propagation) | local model, BYOK key, or the **Epicenter provider** (credits) | the daemon machine | only if it uses the Epicenter provider |
| BYOK browser | the browser | **in-process** (the user sends) | local model, BYOK key, or the **Epicenter provider** (credits) | the browser, in-process | only if it uses the Epicenter provider |

Three facts the matrix encodes:

- **The trigger fork is the floor of the collapse.** The browser needs exactly one bit: kickoff or not (`agentConfig(agent).runtime`). It never "hits" the daemon; it writes the doc and the always-on daemon observes (the doc is the mailbox). Collapsing past the trigger means making the cloud ambient (the B2 refusal: loses the synchronous 402, auth, rate-limit) or making the daemon kicked off (pointless). So the core is shared and the trigger is forked, deliberately.
- **Inference location and tool-execution location are independent.** A tool runs where its data lives (ADR-0020); inference may run elsewhere. The agent declares its tool set as actions (ADR-0010/0018); the core receives that set and dispatches each action to wherever it runs. zhongwen's set is empty today; Local Books' is a local SQL tool.
- **Billing rides the inference backend, not the trigger (ADR-0021).** House-key tokens are metered (Autumn) wherever they are spent: the cloud kickoff, or a local loop calling the metered inference endpoint as an **Epicenter provider** (a `ChatStream` adapter holding the user's account credential, so a daemon gets credits with no raw key). So a daemon can be ambient *and* billed. The three backends (local / BYOK / Epicenter provider) are a per-agent choice; the privacy ladder follows the backend (local = nothing leaves; BYOK = leaves to that provider; Epicenter = leaves to us and the provider), the default is local, and any cloud choice is explicit.

## Why one core (the duplication today)

The stream-into-writer loop is the same algorithm in two files. Extracting it is the keystone brick the B1 analysis called for: design the core as the universal loop+doc-sink, not a cloud/daemon dedup. The seam is small and already implied by the existing `ChatStream` injection:

- The **writer** (`appendAssistantMessage(...)`'s return) is identical across runtimes; it is the single write seam (ADR-0020, kept). Both runtimes already create it.
- The **sink substrate** differs (a live replica that syncs natively vs a hydrated replica forwarded by `room.sync`) but the core does not care: it writes through the writer, the runtime owns how that `Y.Doc` propagates.
- The **trigger + lifecycle + billing** differ and stay in the wrappers (claim via `findUnansweredTurn`, validate, reserve/reconcile).

## The C4 correction

The parts-body spec's Phase 4 (and `chat-reaction.ts:46`) slated `doc-generation.ts` for deletion. That assumed an ambient cloud reaction host (the B2 model). **ADR-0021 refuses B2**: the cloud kickoff is the billing/auth/rate-limit/abuse seam and is kept. So:

- `doc-generation.ts` is **not deleted**. It becomes the cloud-runtime caller of the shared core (the kickoff handler).
- The duplication it carries is resolved by **extraction** (Phase A), and the stale `chat-reaction.ts:46` "slated for deletion / deliberately not shared" comment is rewritten to "shared via the core."
- The deletion prize is the **second conversation-state owner** (the browser's `createChat`-as-source-of-truth and its dual persistence), not the kickoff and not the inference endpoint. `/api/ai/chat` is kept and reframed as the metered **Epicenter provider** backend a local loop calls (it already runs `chat()` with tools and is billed by the existing policy); what dies is a client rendering a conversation from that stream as in-memory state.

## Architecture

```txt
packages/workspace/src/ai/
  chat-doc.ts        owns the Y layout + the writer (appendText/finish, + tool writers Phase B)   [unchanged seam]
  chat-answer.ts     NEW: streamAnswer({ writer, startStream, prompt, signal, tools? })            [the core]
  chat-reaction.ts   attachChatReaction: the daemon trigger wrapper -> calls streamAnswer
  tool-bridge.ts     actionsToAiTools: the agent's action set as provider tools (Phase B feeds the core)

packages/server/src/ai/
  doc-generation.ts  runDocGeneration: the cloud kickoff wrapper (validate + reserve + reconcile) -> calls streamAnswer   [KEPT]

apps/<app>/.../chat   browser answerer (Phase C): user send -> claim in local doc -> streamAnswer(TanStack chat + browser tools); render from doc
```

The core owns the flush policy (one copy of `FLUSH_INTERVAL_MS`/`FLUSH_MAX_CHARS`), the chunk switch, and (Phase B) the tool loop. The wrappers own triggering, claiming, billing, and the sync substrate.

## Implementation Plan

### Phase A: Extract the answer core (B1 keystone, buildable now) — Build

zhongwen text-only is the tracer; both the cloud kickoff and the daemon must stay byte-identical.

- [ ] **A.1** Add `packages/workspace/src/ai/chat-answer.ts`: hoist `streamReply` (the buffer/flush/finish loop) into `streamAnswer({ writer, startStream, prompt, signal })`. One copy of the flush constants.
- [ ] **A.2** `chat-reaction.ts`: `attachChatReaction` calls `streamAnswer` instead of its private `streamReply`. Behavior unchanged (the cancel/teardown/finish semantics stay in the wrapper).
- [ ] **A.3** `doc-generation.ts`: replace the inline `for await` loop with a `streamAnswer` call; keep the kickoff wrapper (validate, `room.sync` forwarding, `waitUntil` drain). Delete its duplicate flush constants.
- [ ] **A.4** Rewrite the stale `chat-reaction.ts:46` comment: the HTTP path is kept (the billed kickoff, ADR-0021) and shares the core; it is no longer "slated for deletion."
- [ ] **A.5** Tests: `chat-answer.test.ts` for the core; confirm `chat-reaction.test.ts` and the server doc-generation tests stay green unchanged. zhongwen end to end on both paths.

### Phase B: The agentic tool loop in the core — needs a forcing consumer (Local Books) — Spike then Build

> Gated on a tool-using agent existing (Local Books + the QuickBooks read spike). zhongwen does not need it. Do not build speculatively; design A's seam so this slots in without redesign (the `tools?` parameter and the writer's tool-part methods are the extension point).

- [ ] **B.1** Spike (Open Question 1): can TanStack's `chat()` agentic loop drive the core with a doc-sink (writing parts as it goes via `StreamProcessor` callbacks), or must the loop be hand-rolled in the core? Prefer reuse.
- [ ] **B.2** Extend the writer (`chat-doc.ts`) with tool-part writers; extend `streamAnswer` to reconcile `TOOL_CALL_*` chunks into tool-call parts, dispatch the action (ADR-0010) where its data lives, and write a capped `tool-result` part (ADR-0020).
- [ ] **B.3** `chatDocToPrompt`: emit tool-call / tool-result ModelMessages from stored parts; add prompt-pruning of old results (`before-last-N`, ADR-0020 deferred).
- [ ] **B.4** Decide the `ChatStream` tool-passing contract (extend to `(messages, signal, tools?)`), tools from `tool-bridge.ts` `.definitions`.

### Phase C: The browser as answerer (render-from-doc tracer) — Build, gates the SSE deletion

- [ ] **C.1** A browser answerer that runs `streamAnswer` in-process (a `ChatStream` backend: a local model, the user's BYOK key, or the **Epicenter provider** that calls the metered `/api/ai/chat` for credits; browser-dispatched tools) and writes into the local conversation doc.
- [ ] **C.2** Migrate ONE SSE app (opensidian or tab-manager) off `createChat`-as-source-of-truth to render-from-doc. This is where render-from-doc's UX (optimistic echo, tool-approval, streaming smoothness) is proven or found wanting.
- [ ] **C.3** Migrate the remaining SSE app.

### Phase D: Delete the second state owner (collect the prize) — Build, after C

> Precise: this deletes the conversation STATE MODEL, not the inference endpoint.
> `/api/ai/chat` survives, reframed as the metered Epicenter-provider backend (it
> already runs `chat()` with tools and is billed); `toServerSentEventsResponse`
> stays as its inference-stream wire format. What dies is a client rendering a
> conversation from that stream as in-memory state.

- [ ] **D.1** Delete the browser's in-memory `createChat`-as-source-of-truth and the dual persistence; the doc is the one store. Update the `/api/ai/chat` route header comment (`routes/ai.ts:11-19`), which still defends SSE as "the interactive transport": it is now an inference backend, and tool execution + approval live in the doc (ADR-0019/0020).
- [ ] **D.2** Sweep stragglers: the createChat-render wrapper, the transport fork in the browser, any text-only-vs-tools branches.
- [ ] **D.3** Keep `/api/ai/chat` (the inference endpoint) and `toServerSentEventsResponse`; they are the Epicenter-provider backend, not part of the deletion.

### Phase E: Billing and the Epicenter provider — Build alongside B/C

- [ ] **E.1** The **Epicenter provider**: a client-side `ChatStream` adapter (daemon and browser) that holds the user's account credential and calls the metered `/api/ai/chat`, so a local loop gets cloud credits without a raw provider key. No new server code (the route and its Autumn policy exist); this is the daemon's `resolveChatStream` gaining a third backend beside local-model and BYOK.
- [ ] **E.2** Key the reservation to the reply being produced (`(responder, entry)` / `generationId`) so a retried kickoff reuses the reservation (ADR-0021 bill-at-the-claim).
- [ ] **E.3** Decide finalize location (Open Question 2): keep the confirm in the route middleware (kickoff stays open) or move `trackTokens` into the DO reaction so the kickoff is a short trigger. Prefer the short trigger; confirm against CF wall-clock limits.

## Greenfield scope: collapse, keep, refuse

Product sentence: *one answer core every runtime runs; one transport (the doc); the trigger forks at the billed kickoff, and that fork is the floor.*

| Path | Verdict | Reason |
| --- | --- | --- |
| `streamReply` (chat-reaction) + inline loop (doc-generation) | collapse now (A) | one algorithm, two copies; extract to `streamAnswer` |
| stale `chat-reaction.ts:46` "slated for deletion" comment | collapse now (A) | ADR-0021 keeps the kickoff; rewrite to "shared via the core" |
| in-memory `createChat` as source of truth + dual persistence | delete (C/D) | render from the doc; one state owner. THE deletion prize |
| `/api/ai/chat` inference endpoint + `toServerSentEventsResponse` | keep, reframe | the metered Epicenter-provider backend a local loop calls; NOT deleted. Rewrite its "SSE is the interactive transport" header comment |
| the cloud kickoff (`doc-generation.ts`) | keep | the billing/auth/rate-limit/402 seam; ADR-0021 B2 refusal |
| the writer API (`appendText`/`finish`) | keep | the single write seam (ADR-0020) the core writes through |
| the trigger fork (`if cloud-runtime kickoff`) | keep | the floor of the collapse; collapsing it is the B2 mistake |
| ADR-0019 envelope (entries/replies, drop role/generationId) | refuse now | deferred; the addressing migration is its own spec |

## Open Questions

1. **Reuse TanStack's loop vs hand-roll (Phase B).** `StreamProcessor` is documented standalone and `chat()` runs the provider->tool->continue loop. Default is reuse; the sub-question is the sink (granular incremental writes via callbacks vs overwrite-snapshot per debounced change). Spike the callback surface first.
2. **Billing finalize location (Phase E).** Middleware-with-open-kickoff (today) vs `trackTokens` in the DO with a short trigger. Prefer the short trigger; confirm CF limits.
3. **Render-from-doc UX parity (Phase C).** Does the doc-observer render match SSE for optimistic echo, tool-approval, and streaming smoothness? The tracer app answers it; if it regresses badly, that is the signal to reconsider, not push through.
4. **Where the browser answerer's claim lives.** The daemon claims via `findUnansweredTurn`; the browser answers its own turn in a local doc. Confirm the claim/idempotency predicate is the same one, so a browser answerer and a future daemon on the same conversation never double-answer.

## Success Criteria

- [ ] One `streamAnswer` core; `chat-reaction.ts` and `doc-generation.ts` both call it; no duplicate flush loop. zhongwen byte-identical on both the cloud kickoff and the daemon (Phase A gate).
- [ ] A tool-using agent (Local Books) runs the same core: tool-call recipe + capped tool-result round-trip through the doc and render on a device without the tool's data (Phase B).
- [ ] One SSE app renders from the doc with acceptable UX; SSE is deleted with no consumer left on it (Phases C/D).
- [ ] House-key cloud inference still works with no BYOK required, billed once at the kickoff, idempotent under retry (Phase E).
- [ ] Self-host passes no billing policy and is free; the `personal()` / `shared({ admit })` seam is untouched.

## References

- `packages/workspace/src/ai/chat-reaction.ts` - `streamReply` to hoist; the daemon trigger wrapper
- `packages/server/src/ai/doc-generation.ts` - the inline loop to replace; the KEPT cloud kickoff wrapper
- `packages/server/src/routes/ai.ts` - the SSE route (`:157`) to delete and the kickoff route (`:193`) to keep
- `apps/opensidian/src/lib/chat/chat-state.svelte.ts`, `apps/tab-manager/src/lib/chat/chat-state.svelte.ts` - the `createChat` SSE consumers to migrate
- `apps/zhongwen/.../ConversationView.svelte` - render-from-doc, already, the tracer for Phase C
- `apps/api/worker/billing/` - `service.ts` reservation lock, `policies.ts` BYOK bypass; the billing seam ADR-0021 keeps at the kickoff
