# 0041. Every answerer is a worker; the browser never answers

- **Status:** Accepted
- **Date:** 2026-06-20
- **Refines:** [ADR-0033](0033-a-conversation-has-one-transport-and-two-triggers.md) (keeps the doc-as-transport doctrine; revises which in-process peer answers a managed conversation), [ADR-0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md) (resolves the latent contradiction toward the hosted-worker quadrant), [ADR-0025](0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-worker.md) (the ephemeral browser writer dissolves)
- **Relates:** [ADR-0030](0030-agents-are-immutable-capability-bundles.md) (trust location), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (workers are peer spokes, the anchor stays blind), [ADR-0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md), [ADR-0038](0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) (the engine the worker resolves)

## Context

ADR-0033 made the open **browser tab** the in-process answerer for cloud conversations, to delete the server-side doc-generation vertical (`runDocGeneration`). That single choice is the root of the answering stack's complexity. From it descend: an in-process browser answer loop, the `owner: 'ephemeral' | 'durable'` routing fork (PR #2127), a browser-side engine walk (`browserEngines` / `resolveEngine`), the metered-SSE-token-passthrough the browser proxies through, and the behavior that **closing the tab kills an in-flight cloud answer**. That last point directly contradicts the product goal that a cloud answer survive the browser closing and be caught up on resync.

Meanwhile ADR-0024 already blesses a **hosted worker** running beside a hosted anchor as the "cloud default shape," and ADR-0035 makes workers peer spokes. So there was a latent contradiction: 0024 says a hosted worker is fine, 0033 says the cloud never writes a doc. The browser-as-answerer was load-bearing for the second only because the first was never built.

## Decision

**Every answerer is a worker:** an in-process peer that observes the conversation child doc and writes the answer into it (ADR-0025's observe → claim → stream → finish loop). A worker runs in exactly one of two **trust locations**, named by the agent's immutable bundle (ADR-0030):

```txt
managed agent  -> an Epicenter-hosted worker (the user chose Epicenter inference)
home/daemon    -> the user's own box (a daemon; nothing leaves the house)
browser        -> NEVER answers; writes user turns and renders the synced doc
```

**Blindness is per-agent, not global.** A managed agent's prompt and transcript flow to the Epicenter-hosted worker *because the user chose Epicenter's metered inference* — the cloud already sees that content today. A daemon agent's data never leaves the user's box. **BYOK is cloud-proxied:** the hosted worker uses the user's key per request, so even BYOK needs no browser answerer. The strong "my key never leaves my device" promise is served by running a daemon, not by the browser; a browser-local-BYOK answerer is a purely additive future option, not part of this decision.

**The hosted worker is an on-demand Durable Object**, built from primitives the room DO already proves (`packages/server/src/room/`):

- It **hibernates when idle** (zero duration cost — confirmed: a hibernating DO and its hibernating WebSockets incur no GB-s).
- It is **woken by a doorbell** — the existing dispatch protocol (`dispatch_request` / `dispatch_inbound`) is the wake nudge — fired by the client that wrote a turn. The nudge is best-effort; the doc is the durable mailbox (ADR-0025), so a missed nudge delays an answer, never loses it (a periodic alarm backstops it).
- On wake it **syncs the conversation child doc as a y-protocols peer** (the room DO already holds a live `Y.Doc` and runs y-protocols SYNC), runs the existing answer loop, streams parts into the doc (→ syncs to every device), and hibernates again.
- **An approval pause costs nothing**: the worker writes the pending tool-call into the doc and hibernates until the approval write rings the doorbell again.

The **same loop runs unchanged** on the user's daemon (Bun) and the hosted worker (DO), because `createRoomCore` and the child-doc worker are runtime-agnostic. The hosted worker is a separate **app-aware spoke**, never the app-blind anchor/room DO (ADR-0024/0035 preserved).

## Consequences

- **The deletion prize:** `attachChatBrowserAnswerer` and its wiring, the `owner: 'ephemeral' | 'durable'` fork (PR #2127), the browser engine walk + `browserEngines`, and the metered-SSE-token-passthrough to the browser. The `this-device` ephemeral agent **dissolves** into a managed (hosted-worker) agent; the Vocab catalog becomes two **durable** agents distinguished only by trust location: managed (Epicenter) and home daemon.
- **Close-browser durability is free for every agent** — the worker keeps writing; the interactive/ambient distinction disappears.
- **Cost is pennies per user per month:** DO duration is billed only during the generation wall-clock (~$0.00005 for a 30 s answer); idle and waiting-for-approval are free under hibernation. ADR-0033's "~$4/user-month idle residency" fear was about an always-on worker; on-demand hibernation eliminates it.
- **The server-side Yjs peer returns**, but it is the daemon's existing loop on a DO host using `room/*` patterns, not a new primitive — and it is a separate spoke, so the anchor stays blind.
- **PR #2127 is largely superseded** (owner ⊥ engine collapses to trust-location, which is already in the immutable bundle, ADR-0030). **PR #2128 (presence) parks** — it decorates liveness, never gates binding (the doc is a durable mailbox).
- **The `/api/ai/chat` SSE endpoint survives** as the hosted worker's path to the provider and as a general metered inference API; it is no longer the browser's answering path.

## Considered alternatives

- **Keep ADR-0033 (the browser answers cloud conversations).** Rejected: it is the root of the answering-stack complexity and denies the close-browser durability the product wants. Durability-via-daemon alone forces every casual user onto a co-deployed box.
- **An always-on hosted worker.** Rejected: the residency cost ADR-0033 feared. On-demand hibernation + the existing dispatch doorbell makes it pennies, with no permanent listener.
- **Run the loop inside the room/anchor DO** (which already holds the `Y.Doc`). Rejected: it makes the app-blind anchor app-aware, breaking ADR-0024/0035. The worker is a distinct spoke that syncs the child doc.
- **Browser-local BYOK (the key never leaves the device).** Deferred, not refused: cloud-proxied BYOK is chosen for the clean collapse; an in-process browser answerer for device-local keys is additive later and does not disturb this architecture.
