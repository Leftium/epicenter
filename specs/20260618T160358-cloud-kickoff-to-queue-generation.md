# Cloud generation runs off a queue: the doc-gen kickoff is a cloud concept, not a library route

**Date**: 2026-06-18
**Status**: Draft
**Owner**: Braden
**Branch**: (to start) `feat/cloud-kickoff-to-queue`
**Implements**: [ADR-0022](../docs/adr/0022-the-trigger-forks-on-compute-ownership-and-cloud-generation-runs-off-a-queue.md)
**Relates**: [ADR-0021](../docs/adr/0021-a-conversation-has-one-transport-and-two-triggers.md) (the one-transport/two-trigger model this refines; resolves its billing-finalize open question), [ADR-0017](../docs/adr/0017-durable-storage-is-one-per-person-coordination-box.md) (the relay this keeps blind, now strictly), [ADR-0020](../docs/adr/0020-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) (interrupted-artifact crash recovery)
**Sibling**: `specs/20260618T113407-one-conversation-core-loop-and-doc-sink.md` (this is the corrected, concrete form of that spec's Phase D/E for the *cloud* runtime; the answer-core extraction it depends on already landed)

## One Sentence

The doc-generation HTTP kickoff is a **rented-compute concept**, so it leaves the shared library entirely: `packages/server` becomes relay + auth + ownership + SSE only, **apps/api owns the whole cloud doc-gen vertical** (kickoff route → Cloudflare Queue → ephemeral consumer Worker that runs the existing `runDocGeneration`), self-host loses server-side doc generation (it answers ambiently with a resident daemon, per ADR-0022), billing reserves at the kickoff and confirms in the consumer, and a cloud answer now completes even if the tab closes — with no Durable Object ever paying resident duration to generate.

## The collapse (read this first)

The earlier draft asked "how do we make the cloud-only reserve+enqueue pluggable into the library doc route without leaking billing/infra into the shared library?" and offered two seams (inject a strategy vs mount our own route). **Both accept a false premise.** The doc-generation HTTP route was never a library responsibility.

Ground truth (verified 2026-06-18):

- `runDocGeneration` (hydrate a replica via `room.getDoc()`, forward each `updateV2` to `room.sync()` over RPC) has **exactly one production caller**: the library's cloud doc route (`packages/server/src/routes/ai.ts:228`).
- The owned-compute answerers do **not** use it. `attachChatReaction` (daemon) and `attachChatBrowserAnswerer` (tab) operate on a **local `Y.Doc` in-process**, wiring `streamAnswer` straight into the doc's own writer/observer — no `room.sync`, no `getDoc`, no RPC. They are in-process sync peers.

So "generate into a doc you don't own, poked from outside, syncing over the room's public RPC" **is the definition of rented compute** (ADR-0022). It is the one thing only the cloud needs. Self-host mounts the route today (`apps/self-host/worker/index.ts:68`) but a self-hoster following ADR-0022 answers with a resident daemon and never pokes it; the held-open server-side generation is a pre-ADR-0022 vestige.

**Therefore the route leaves the library.** `mountAiApp` mounts only the SSE route. apps/api owns the kickoff route + the Queue + the consumer, with nothing to keep agnostic, because there is no shared route anymore. `runDocGeneration` stays an **exported, billing-free mechanism** in `packages/server/ai` (a sync-peer that drives a room over its *public* RPC), which the cloud consumer imports. This is subtractive: it deletes the route from the library instead of adding a seam, and it sharpens ADR-0017 — nothing in the request-handling library reads conversation semantics at all.

**The feature this deliberately drops: server-side doc generation in self-host.** This is a clean break (self-host is community-supported; ADR-0022 already routes self-host through the daemon). Recorded in ADR-0022.

## How to read this spec

```txt
Read first:
  One Sentence
  The collapse
  Why this shape (the CF cost model)
  Current State
  Target Shape
  Implementation Plan
  Success Criteria

Read if challenging the design:
  The refusals
  Open Questions
  ADR-0022 (the durable decision and its rejected alternatives)

Scope boundary:
  This is the CLOUD runtime's execution-context change, plus the subtractive move
  of the doc-gen route out of the shared library. The shared answer core
  (streamAnswer) is unchanged. The owned-compute path (daemon =
  attachChatReaction, browser tab = attachChatBrowserAnswerer) is untouched. The
  SSE route (/api/ai/chat) is untouched (it is interactive and dies-with-client
  by design; a client-connected Worker has no duration charge).
```

## Decisions settled (2026-06-18 discussion)

1. **The doc-gen route leaves the library (the collapse above).** `mountAiApp` = SSE only. apps/api owns kickoff + Queue + consumer. `runDocGeneration` stays exported as a mechanism. Self-host loses server-side doc-gen.
2. **Billing is reserve-fixed-credit + confirm/release, not token metering.** There is no `trackTokens` in the codebase. `reserveAiChat` reserves a fixed per-model credit cost from the catalog (`apps/api/worker/billing/service.ts`); today the policy calls `reservation.confirm()` on success or `reservation.release()` on a pre-stream failure. Moving billing into the consumer moves *that finalize call site*, not building per-token accounting. Wherever an earlier draft said "settle actual tokens (`trackTokens`)", read **confirm the reservation** (release on a no-op / pre-stream error).
3. **The reservation is keyed to `generationId` so it can cross the queue.** Today `Reservation` is a closure over a random `lockId` that "never escapes the service". The kickoff and the consumer are different invocations, and a JSON message can't carry a closure. So the lock id becomes **derived from `generationId`** and the service gains a serializable `finalizeReservation({ generationId, action })` the consumer calls. The job carries `generationId` + `customerId`, which is all finalize needs. **Verify first:** Autumn must treat a repeated `lockId` idempotently (a retried kickoff reuses, not stacks the hold). If it stacks, the "bills once, idempotent under retry" criterion is false and we need a guard — check via the `autumn` skill / docs before relying on it.
4. **Cloud "stop" is dropped — a cloud answer always completes.** Today stop = abort the held-open fetch → `signal.aborted` → `finish: cancelled`. Detached in the consumer, the client can't reach the generation, and the consumer by design never reads the doc back mid-generation, so there is no in-band cancel channel either. The stop button hides/disables for resident-less (rented-compute) agents; the durable-mailbox property *is* "you wrote the turn, you get the answer". The consumer runs to completion; `runDocGeneration`'s `cancelled` finish becomes reachable only via consumer teardown, not user action. (ADR-0020's interrupted-artifact recovery still covers a crash.)
5. **House-key only through the queue.** Doc-gen BYOK (`apiKey` in the body) is **not** carried in the `GenerationJob` — no user key sits in a CF queue. Cloud doc-gen uses the deployment house key; a BYOK doc-gen request is refused at the kickoff with a clear error rather than silently billed. (The SSE route's BYOK is untouched.)

## Why this shape (the Cloudflare cost model)

Grounded against the CF docs (DeepWiki `cloudflare/cloudflare-docs`, 2026-06-18) and the live `Room` Durable Object (`packages/server/src/room/backends/cloudflare/durable-object.ts`). These facts are load-bearing; re-verify before building if the platform has moved:

- **Workers do not bill for I/O-wait duration; Durable Objects do.** A DO bills "duration" (GB-seconds, 128 MB) for every wall-clock second it is resident and non-hibernating — including while idle-awaiting a streaming `fetch` — at $12.50 / M GB-s. A normal Worker bills only CPU time and requests, never I/O-wait wall-clock. So a 2-minute generation costs ~$0.0002 of DO duration *if run in a DO*, and ~$0 of duration if run in a Worker.
- **An HTTP Worker held open by a client has no duration charge and no hard wall-clock cap** (as long as the client stays connected). That is exactly today's held-open kickoff — cheap, but the generation dies when the client disconnects (`waitUntil` only extends 30 s). (This is also why the SSE route is fine held-open: it is interactive and dies-with-client by design.)
- **A queue-consumer Worker (and a cron Worker) runs up to 15 minutes of wall-clock with no client connection**, billed as a Worker (no I/O-wait duration). CPU limit is 30 s default, raisable to 5 min via `limits.cpu_ms`. This is the cheap, client-independent execution context the cloud generation wants.
- **A Durable Object can be a Queue producer and can service-bind to other Workers.** So the kickoff (or, if ever needed, the DO) can enqueue without staying resident.
- **The room DO already uses the WebSocket Hibernation API and Alarms** and is **content-agnostic** (it relays Yjs bytes; it does not read the doc's meaning). Keeping it blind is a hard constraint (ADR-0017, ADR-0004).

Conclusion: do not run the generation in a DO (duration cost) and do not make the cloud ambient (a resident observer that also breaks relay blindness). Run it in a queue consumer, triggered by a short client kickoff — and own that whole vertical in the cloud deployment, not the shared library.

## Current State

- **Doc kickoff route** (`packages/server/src/routes/ai.ts`, the `/api/ai/chat/doc` handler near `:193`): authenticates, runs the billing policy, resolves the room stub, and calls `runDocGeneration({ room, signal, waitUntil, startStream })` **inline**, holding the request open for the whole generation. Billing confirms in the route middleware while the request is open. Mounted by both cloud and self-host via `mountAiApp`. **This route is leaving the library** (the collapse).
- **`runDocGeneration`** (`packages/server/src/ai/doc-generation.ts`): hydrates a replica via `room.getDoc()` (RPC), validates (idempotency via existence-is-the-claim, single active generation, a user turn to answer), snapshots the prompt, appends the assistant message, drives `streamAnswer`, forwards each transaction's `updateV2` to `room.sync()` (RPC), writes the terminal `finish`, drains. Already runtime-agnostic over `room` and `startStream`. **Stays put, stays exported, re-triggered (HTTP → queue), not rewritten.**
- **Room registry** (`packages/server/src/room/backends/cloudflare/registry.ts`): `createDurableObjectRooms(env.ROOM).get(name)` resolves a `ResolvedRoom` stub from a name with **zero request context** — the consumer uses this directly. Currently library-internal; export it (or a thin equivalent) for the consumer.
- **Room DO** (`packages/server/src/room/backends/cloudflare/durable-object.ts`): exposes `sync(body)` and `getDoc()` as RPC methods; hibernatable; blind. Untouched.
- **Billing** (`apps/api/worker/billing/`): `service.ts` holds the reserve/confirm/release lock (`reserveAiChat` → `Reservation` closure over a random `lockId`); `policies.ts` (`chargeAiCreditsWithAutumn`) wraps the route, reserves before `next()`, confirms/releases after. Autumn calls are `customerId`-based and safe from a background context (ADR-0021).
- **Worker entry** (`apps/api/worker/index.ts`): `export default app` (Hono instance as fetch handler) + `export { Room }`. Needs `export default { fetch: app.fetch, queue }` to add a consumer.
- **Self-host** (`apps/self-host/worker/index.ts:68`): mounts `mountAiApp(app, { auth, ownership })` with no billing and no queue. After the collapse it mounts SSE only; doc-gen disappears (intended).
- **Browser** (`apps/zhongwen/.../ConversationView.svelte`): `nudgeBoundAgent()` fires the kickoff for `runtime === 'cloud'` and **awaits** it (`kickoffController`); `externallyGenerating: kickoffController !== null` feeds open-request liveness into `chatRenderState`; `stop()` aborts `kickoffController`. `AgentConfig.runtime` is `'cloud' | 'daemon'` (`apps/zhongwen/src/agents.ts`, tested in `agents.test.ts`).

## Target Shape

```txt
LIBRARY (packages/server) after this spec:
  relay (blind room DO) + auth + ownership + SSE route (/api/ai/chat)
  exports runDocGeneration (mechanism) + the room registry (mechanism)
  NO doc-generation HTTP route, NO chat-awareness in any request handler

CLOUD (apps/api) owns the whole doc-gen vertical:

  browser ──writes user turn into the doc (optimistic echo, syncs to the room)
          └─POST /api/ai/chat/doc/kickoff  (SHORT, apps/api route)
                 ├─ auth (requireBearerUser) + ownership
                 ├─ refuse BYOK (house-key only)                    ── clear error, synchronously
                 ├─ getDoc → read generationId off the unanswered turn (400 if none/answered)
                 ├─ reserve credits (Autumn lock keyed to generationId)  ── 402 here, synchronously
                 ├─ enqueue { roomName, generationId, model, systemPrompts, customerId }
                 └─ 200 (returns in ms; NO held-open generation)

  Cloudflare Queue ──delivers──▶ consumer Worker (ephemeral, ≤15 min, no duration billing)
                 ├─ resolve the room stub from roomName (createDurableObjectRooms(env.ROOM).get(roomName))
                 ├─ runDocGeneration({ room, signal, waitUntil, startStream })  ← library mechanism, queue-triggered
                 ├─ finalizeReservation({ generationId, action: completed ? 'confirm' : 'release' })
                 └─ ack

  every client renders the doc as updates sync back via room.sync RPC.

OWNED compute (unchanged, already built):
  daemon      → attachChatReaction over the live doc (ambient, native sync)
  browser tab → attachChatBrowserAnswerer over the local doc (in-process)

SELF-HOST: SSE only. Server-side doc-gen removed (answer with a daemon).
```

The browser's trigger fork stays exactly **one bit**, renamed from a chat concept to a compute-site concept: *is the bound agent answered by a resident listener (do nothing) or by rented compute (fire the short kickoff)?*

## Implementation Plan

Tracer: zhongwen's cloud agent (text-only) end to end. Keep `runDocGeneration`'s behavior identical; only its home (library route → cloud queue consumer) and the billing-finalize location move.

### Wave 1: Queue + consumer + billing-finalize seam (apps/api) — additive

Nothing is removed yet; the old library route still serves cloud, so the repo works at the checkpoint.

- [ ] **1.1** Declare a Cloudflare Queue (`ai-generation`) producer + consumer binding in `apps/api/wrangler.jsonc`; regenerate worker types (`bun run --cwd apps/api ...types`). Consumer `max_batch_size: 1` (generations are independent), `max_retries` small, `limits.cpu_ms` headroom (~300000) for long streams.
- [ ] **1.2** A typed `GenerationJob`: `{ roomName, generationId, model, systemPrompts?, customerId }`. `roomName` is the fully-resolved DO name `doName(ownerId, guid)` (computed at the kickoff where `ownerId` is known), so the consumer needs no auth/ownership. **No `apiKey`** (decision 5). The prompt is re-read from the doc, not carried.
- [ ] **1.3** Consumer entrypoint (`apps/api/worker/ai-generation-consumer.ts` or similar): per message, resolve the room (`createDurableObjectRooms(env.ROOM).get(roomName)`), build the house-key `chat()` adapter (the same `resolveAdapter` path the route uses today, house key only), call `runDocGeneration({ room, signal: <never-aborts>, waitUntil: ctx.waitUntil, startStream })`, then `finalizeReservation` (confirm on a real generation result, release on a no-op/validation error). Ack on success; a thrown error triggers redelivery (idempotent — 3.x).
- [ ] **1.4** Worker entry: `export default { fetch: app.fetch, async queue(batch, env, ctx) { ... } }`. Keep `export { Room }`.
- [ ] **1.5** Billing service (`service.ts`): make the reserve lock id derive from `generationId` (pass it through `reserveAiChat`/`reserveAiCreditsWithLock`), and add a serializable `finalizeReservation({ generationId, action })` the consumer calls without the closure. Export `createDurableObjectRooms` from `@epicenter/server` if not already.
- [ ] Checkpoint: server + apps/api typecheck clean. Commit (additive).

### Wave 2: Flip the kickoff to apps/api, strip the doc route from the library — the break

- [ ] **2.1** Register the kickoff route in apps/api (own Hono sub-app or alongside billing routes): `POST /api/ai/chat/doc/kickoff` (or keep the existing `/api/ai/chat/doc` URL for browser compatibility — decide by what the browser sends). Behavior: auth + ownership, refuse BYOK with a clear error, `getDoc` → read `generationId` (400 `NoUserMessage` / `GenerationAlreadyExists` taxonomy preserved here), reserve keyed to `generationId` (402), enqueue `GenerationJob`, return 200. Reserve **before** enqueue so out-of-credits is a synchronous 402 and nothing is enqueued.
- [ ] **2.2** Remove the doc route from the library `mountAiApp` (SSE only). Remove `runDocGeneration`'s import from `routes/ai.ts`; keep `runDocGeneration` exported from `@epicenter/server` (`ai/index.ts` or package exports). Drop the now-cloud-only `chargeAiCreditsWithAutumn` wrapping of the doc route (the kickoff route calls billing directly; the SSE policy stays).
- [ ] **2.3** Update tests: the library's doc-route tests move/retire; `doc-generation.test.ts` (drives `runDocGeneration` against an in-process room) **stays** — it is the mechanism's contract. Self-host needs no change beyond losing the route (confirm its tests/README reflect SSE-only).
- [ ] Checkpoint: `bun test` green in `packages/server` + apps/api; typecheck clean. Commit (the break + the cloud kickoff together — one coherent reviewable unit).

### Wave 3: Browser — short kickoff, drop stop, reconcile-on-load, site shape

- [ ] **3.1** `kickoffGeneration`: fire the short kickoff and return; do **not** hold a controller open for the generation's lifetime. The doc render drives liveness. Drop or shrink `externallyGenerating` (Open Question 3 — measure the reserve+enqueue round-trip; if sub-second, let the doc alone drive liveness).
- [ ] **3.2** Drop `stop()` for rented-compute agents (decision 4): hide/disable the stop affordance when the bound agent is resident-less; remove the kickoff-abort path.
- [ ] **3.3** Reconcile-on-load: on conversation open, for each unanswered turn the client owns whose agent is rented-compute, re-fire the short kickoff (idempotent via 1.5/2.1/3.x). Recovers a turn whose client died before its kickoff completed.
- [ ] **3.4** Recharacterize `AgentConfig.runtime` from `'cloud' | 'daemon'` to a compute-site shape (e.g. `site: { kind: 'epicenter-cloud' | 'self-daemon'; resident: boolean }`), and read the single "do I poke?" bit off `resident`. Keep zhongwen exactly two sites (cloud + optional self-daemon); **do not** add a browser-local site (one-conversation-core C.3 verdict). Update `agents.test.ts`.
- [ ] Checkpoint: `svelte-check` 0 errors for zhongwen; `agents.test.ts` green. Commit.

### Wave 4: Verify + final review + harvest

- [ ] **4.1** zhongwen cloud agent answers end to end through the queue (local `wrangler dev` queue or deployed). Close the tab mid-generation → the answer still completes and is present on reload (the durable-mailbox win). The daemon path is unchanged and still answers ambiently. One turn is never answered twice across triggers.
- [ ] **4.2** Run `post-implementation-review` on the touched files; clean up stale abstractions / dead paths / naming.
- [ ] **4.3** Flip ADR-0022 to `Accepted`. Delete this spec (`git rm`; git + `docs/spec-history.md` keep the body). Run `bun run scripts/check-doc-hygiene.ts`.
- [ ] **4.4** (Deferred / optional) The shared doc-chat controller hook collapse into `@epicenter/svelte` (one-conversation-core's deferred item), built once against the final short-kickoff trigger shape, trigger injected (zhongwen injects the short kickoff; opensidian injects the in-process `answer()`). Only land it if it earns its keep per `one-sentence-test` / `cohesive-clean-breaks`. Not gating this spec.

## The refusals (do not drift)

| Refuse | Why |
| --- | --- |
| Keeping a doc-generation HTTP route in the shared library | the kickoff is a rented-compute concept (ADR-0022); the library is relay + auth + ownership + SSE only |
| Server-side doc generation in self-host | owned compute answers ambiently with a resident daemon (ADR-0022); the held-open server route is a pre-ADR vestige |
| Injecting a doc-execution strategy into `mountAiApp` | over-engineered: it keeps a route the library shouldn't host. Remove the route instead |
| Running the generation in the room DO | DO bills resident I/O-wait duration; a Worker does not |
| Making the cloud ambient (a resident observer answers from sync) | pays residency AND forces chat semantics into the blind relay (ADR-0017/0004) |
| Putting any chat-awareness into the room DO | it is the content-agnostic relay; chat lives in the cloud kickoff route + consumer only |
| Keeping the held-open kickoff | the generation must outlive the tab (durable mailbox) |
| A direct service-binding fetch instead of a queue | the generation outlives the request; `waitUntil` caps at 30 s |
| Rewriting `runDocGeneration` | it is re-homed (library route caller → cloud queue consumer) and re-triggered, not redesigned |
| Carrying the BYOK key through the queue | house-key only; no user key at rest in a CF queue message (decision 5) |
| An out-of-band cancel for cloud stop | stop is dropped for rented compute; the answer always completes (decision 4) |
| Adding a browser-local agent to zhongwen | text-only/cloud-model app; the browser answerer earns its keep only in the local-tool corner (opensidian/Local Books) |

## Success Criteria

- [ ] The doc-generation HTTP route no longer exists in `packages/server`; `mountAiApp` mounts SSE only; nothing in the request-handling library reads conversation semantics. `runDocGeneration` is still exported and its contract test passes.
- [ ] A cloud (rented-compute) turn is answered by a queue-consumer Worker in apps/api, not a held-open request; it completes after the tab closes and renders on reload.
- [ ] No Durable Object accrues resident duration to generate; the room DO carries no conversation-semantics code.
- [ ] "Out of credits" still returns a synchronous 402 at the kickoff; BYOK doc-gen is refused synchronously; a clean answer bills once at the claim, idempotent under retry and queue redelivery (pending the Autumn idempotency check, decision 3).
- [ ] The owned-compute path (daemon, browser tab) is untouched and still answers ambiently; one turn is never answered twice across triggers.
- [ ] Self-host mounts SSE only and is free; the `personal()` / `shared({ admit })` seam is untouched. Self-host losing server-side doc-gen is recorded in ADR-0022.
- [ ] `bun test` green in touched packages; `svelte-check` 0 errors for touched apps; workspace + server + apps/api typecheck clean; no `console.*` in library code.

## Open Questions

1. **Kickoff route URL.** Keep `/api/ai/chat/doc` (browser sends it today, smallest browser diff) or rename to `/api/ai/chat/doc/kickoff` (clearer). Decide by the browser change in Wave 3; renaming is free since apps/api now owns the route.
2. **Autumn lock idempotency (blocks decision 3's idempotency claim).** Does `autumn.check({ lock: { lockId } })` with a repeated `lockId` reuse the hold or stack a second one? If it stacks, reconcile-on-load re-pokes would double-hold transiently. Verify via the `autumn` skill / Autumn docs; if it stacks, add a guard (e.g. the kickoff checks the doc for an existing claim before reserving).
3. **`externallyGenerating` after 3.1.** Once the kickoff returns in ms, is the pre-claim window short enough to drop the external-generating signal entirely and let the doc alone drive liveness? Measure the reserve+enqueue+sync round-trip before deciding.
4. **`runDocGeneration`'s home.** Once the library route is gone, its only caller is apps/api's consumer. Keep it exported from `packages/server/ai` (a deployment-agnostic mechanism, minimal churn, tests stay) — chosen — or move it into apps/api. Revisit only if a second consumer never appears and the export feels orphaned.
5. **Queue redelivery vs interrupted-artifact resume.** A crashed consumer leaves an interrupted artifact; redelivery re-runs the job but `GenerationAlreadyExists` no-ops it (the half-finished claim is not auto-resumed). Confirm this is intended (manual retry re-mints a new generationId), or design explicit resume later — not now.
6. **Cloudflare Queues require a paid Workers plan and the queue provisioned.** `wrangler dev` supports local queues for the tracer; production needs `wrangler queues create ai-generation`. Operational, not a code blocker.

## Grounding & best practices (for the executor)

- Re-verify the CF facts in "Why this shape" against DeepWiki `cloudflare/cloudflare-docs` and the installed `wrangler` / `@cloudflare/workers-types` before relying on a limit. Verify the Autumn lock idempotency question (OQ2). Load skills: `cloudflare-workers`, `autumn`, `tanstack-ai`, `hono`, `svelte`, `workspace-app-composition`, `cohesive-clean-breaks`, `post-implementation-review`.
- Stage specific files only; never `git add .`/`-A`; no AI attribution in commits. Use `bun` (`bun test` / `bun run` / `bun x`).
- Two-state lifecycle + doc-hygiene gate apply: `bun run scripts/check-doc-hygiene.ts`. Flip ADR-0022 to `Accepted` when the work lands; delete this spec on completion (git keeps the body).

## References

- `packages/server/src/ai/doc-generation.ts` — `runDocGeneration`, the exported mechanism re-triggered behind the queue (unchanged behavior)
- `packages/server/src/routes/ai.ts` — loses the doc route; keeps SSE; `mountAiApp` mounts SSE only
- `packages/server/src/room/backends/cloudflare/registry.ts` — `createDurableObjectRooms`, exported for the consumer to resolve a stub with no request
- `packages/server/src/room/backends/cloudflare/durable-object.ts` — the blind room DO (`sync` / `getDoc` RPC); stays content-agnostic
- `apps/api/wrangler.jsonc`, `apps/api/worker/index.ts` — Queue bindings + `{ fetch, queue }` entry + the new kickoff route
- `apps/api/worker/billing/service.ts`, `policies.ts` — reserve keyed to `generationId` + serializable `finalizeReservation`; SSE policy unchanged
- `apps/self-host/worker/index.ts` — mounts SSE only after the collapse
- `apps/zhongwen/src/routes/(signed-in)/components/ConversationView.svelte`, `apps/zhongwen/src/agents.ts` — short kickoff, drop stop, reconcile-on-load, the compute-site shape
- `packages/workspace/src/ai/chat-answer.ts` — the shared `streamAnswer` core (unchanged); `chat-reaction.ts` / `chat-browser-answerer.ts` — owned-compute answerers (unchanged)
