# 0021. A conversation has one transport (the synced doc) and two triggers

- **Status:** Proposed
- **Date:** 2026-06-18
- **Relates:** [ADR-0019](0019-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) (the addressed regions a reply is written into), [ADR-0020](0020-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) (the parts body streamed into Y.Text), [ADR-0010](0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md) (actions are the tools), [ADR-0017](0017-durable-storage-is-one-per-person-coordination-box.md) (the anchor), [ADR-0018](0018-agents-are-immutable-capability-bundles.md) (agents)

> **Vocabulary:** a **transport** is how an answer reaches the people watching a
> conversation. A **trigger** is how an answerer *starts* working. An **answerer**
> is a runtime that writes a reply: the **cloud** runtime (house-key inference in a
> Durable Object), a **BYOK browser agent** (the user's own key, in the browser),
> or a **self-hosted daemon** (the user's compute). A **kickoff** is the
> authenticated POST that asks the cloud to generate one turn. The **doc-sink** is
> the answerer writing parts (ADR-0020) into the synced child doc as it goes.

## Context

There are three ways an answer is produced today, and they fork the system along
two seams at once. The SSE route (`/api/ai/chat`) streams tokens back over an open
HTTP connection while the browser holds the conversation in TanStack `createChat`
in-memory state (opensidian, tab-manager). The cloud doc one-shot
(`runDocGeneration`, behind `/api/ai/chat/doc`) streams into a synced Y.Doc that
the client renders (zhongwen). The daemon observer (`attachChatReaction`) does the
same doc streaming with no HTTP at all. That is two transports (SSE vs the doc),
two conversation-state owners (in-memory client vs the synced doc), two
persistence models, and a text-only-vs-tools split, all for the same act. ADR-0020
just made the body one shape (parts streamed into Y.Text), which removes the last
structural reason for SSE to exist: a tool-using answer now fits in the doc.

The pressure to keep SSE was the fear that deleting it would endanger the revenue
model. Grounding against the billing code (`apps/api/worker/billing/`) and Autumn
shows the opposite: money is made on house-key cloud inference, the billed surface
is the cloud answerer reached through the kickoff, and SSE was never the revenue,
only a transport. Autumn's calls are `customerId`-based and safe from a Durable
Object or background context, so metering does not need an open HTTP request.

## Decision

A conversation has **one transport and two triggers**, and **billing rides the
inference backend, not the trigger**. Every answerer, in every runtime, streams
parts into the synced child doc (ADR-0019's reply regions, ADR-0020's parts body);
the client always renders the doc. What is deleted is the **second
conversation-state owner** (the browser holding the thread in `createChat` as the
source of truth and rendering from an SSE stream), not the inference endpoint,
which survives as a metered backend (see the deletion-prize consequence).
Answerers vary on three orthogonal axes:

```txt
transport (how the answer arrives):  the synced doc.  ONE. The client always renders the doc.

trigger   (how the answerer starts): kickoff    -> hosted, an authed POST (the 402/auth/rate-limit boundary)
                                     ambient    -> a daemon observing the doc (the mailbox)
                                     in-process -> a browser running its own loop

inference (whose tokens, who bills): house key  -> metered via Autumn wherever it is spent:
                                                   the cloud kickoff, OR an "Epicenter provider"
                                                   a local loop calls for credits
                                     BYOK       -> the user's own provider key; free of Epicenter
                                     local      -> a model on the user's machine; free, nothing leaves
```

- **Collapse the transport; keep the trigger fork.** The browser no longer chooses
  between an SSE handler and a doc kickoff; it always renders the doc. But it still
  fires the billed kickoff *only* for cloud-runtime conversations
  (`agentConfig(agent).runtime === 'cloud'`), and a daemon/BYOK conversation fires
  no kickoff. The transport fork dissolves; the trigger fork is load-bearing and
  stays. The system is one transport, two triggers, not one of everything.

- **The kickoff is the billing, auth, rate-limit, and abuse seam, so it is not
  deleted (refuse a pure ambient cloud host).** Making the cloud answer from
  ambient sync alone would have to write credit rejections into the doc, rate-limit
  at the sync layer, and meter with no request boundary, all harder for no gain.
  "Out of credits" wants a synchronous 402 *before* a pending answer appears. The
  kickoff exists only on the hosted path (self-host has no kickoff; its daemon
  answers ambiently and free), which is exactly the billed path. This is
  `runDocGeneration` today, so the cloud path barely changes: delete SSE, keep the
  kickoff.

- **Billing rides the kickoff: reserve, then reconcile.** The kickoff reserves
  against an estimate (`check` with the existing lock), fails closed with a 402 if
  the owner is broke, and triggers the generation. Actual tokens are reconciled at
  completion (`trackTokens`): a clean answer settles to the tokens spent and
  releases the over-reservation; an error before any tokens are consumed releases
  the whole reservation; tokens already consumed when a stream dies mid-way are
  billed, not refunded (the current non-refundable-consumed behavior, kept). The
  customer is the room's `ownerId`, which the answerer already knows. The
  reserve-confirm-or-release lock already exists in `service.ts`.

- **Bill at the claim, for idempotency.** Key the reservation to the reply being
  produced (ADR-0019's `(responder, entry)`, today's assistant message keyed to
  `generationId`). A retried kickoff or a reconnect finds the reply already claimed
  and reuses the existing reservation instead of stacking a second charge.
  Idempotent billing falls out of the existence-is-the-claim mechanism the doc
  already has.

- **Billing rides the inference backend, via the Epicenter provider; a daemon need
  not wire a raw key.** House-key tokens are metered (Autumn) at whatever authed
  boundary spends them, and there are two: the cloud kickoff (the cloud runs the
  whole loop) and the inference endpoint (a local daemon or browser runs the loop
  and calls out only for inference). The second is the **Epicenter provider**: a
  client-side `ChatStream` adapter that holds the user's account credential and
  calls the metered endpoint, so a daemon gets cloud credits without a raw provider
  key. This is cheap: the endpoint already exists (`/api/ai/chat` runs `chat()` with
  tools and is billed by the existing `chargeAiCreditsWithAutumn` policy), so the
  Epicenter provider is client code only. Consequence: a daemon can be
  ambient-triggered *and* billed. "Billed = cloud kickoff, free = daemon" was too
  coarse; billing follows whose tokens pay, not how the answerer was triggered.

- **Inference is a per-agent choice of three backends.** Local model (free, nothing
  leaves the machine), BYOK provider (the user's key; free of Epicenter; data goes
  to that provider), or the Epicenter provider (the user's credits; metered). The
  daemon's existing `ChatStream` seam is the plug. So managed "log in, no keys"
  inference survives SSE deletion at every runtime, not just the cloud kickoff, and
  BYOK is one option, never a requirement.

- **Self-host stays free by configuration, not by construction.** A self-host daemon
  on a local model or a BYOK key is free; the hosted-only billing policy is injected
  via `mountAiApp` and self-host passes none. (A self-host that pointed its loop at
  the hosted Epicenter provider would bill, but that is a deliberate choice, not the
  default.) The `personal()` / `shared({ admit })` deployment seam is untouched.

The doctrine is one sentence: *a conversation is a synced doc that every answerer
streams parts into and the client always renders; the answerer's trigger and its
inference backend are independent axes, and billing follows the backend (the house
key), not the trigger.*

## Consequences

- **The deletion prize is the second conversation-state owner, not an HTTP
  endpoint.** Be precise here, because the naive reading deletes the wrong thing.
  Gone: the browser holding the thread in `createChat` as the source of truth; the
  dual persistence (a client store beside the doc); the text-only-vs-tools split
  (ADR-0020); the transport fork in the browser. The client renders the doc.
  **Kept and reframed:** the inference endpoint (`/api/ai/chat`, which already runs
  `chat()` with `tools` and is billed by the existing Autumn policy) becomes the
  metered **Epicenter provider** backend a local loop calls; its
  `toServerSentEventsResponse` wire format stays (SSE is a fine inference-stream
  format, the way providers stream). What dies is *a client rendering a conversation
  from that stream as in-memory state*, not the stream itself. `runDocGeneration`
  becomes the cloud-runtime call of one shared core; `chat-reaction.ts`'s reduction
  becomes the shared loop plus a doc-sink (the B1 / Phase-3 work, the universal core,
  not a cloud/daemon dedup).

- **Wins beyond dedup.** Every tab and device renders one stream from the shared
  doc instead of fragmenting per in-memory client. A turn bound to an offline
  daemon waits in the doc until that daemon wakes (SSE cannot queue). And there is
  one conversation primitive to test.

- **Privacy is a user-controlled, transparent choice, not a fixed promise.** An
  earlier framing ("the data never leaves the house") was too absolute. A
  data-reading agent's tool results enter the prompt, so the *inference backend*
  decides where the data goes: a local model keeps it on the machine, a BYOK cloud
  provider sends it to that provider, the Epicenter provider sends it to us and the
  provider. The decision: the user controls the backend, the default is local, any
  cloud choice is explicit, and a private result is never routed to a model the user
  did not choose (no silent cloud binding). Local Books defaults to local inference
  as a transparent default, not a hard lock. The promise is control and
  transparency, not absolute locality.

- **The relay round-trip is an edge case the local-loop model avoids.** The one
  thing an open SSE connection did better was interleaving cloud inference with a
  browser-side tool at low latency in a single turn. That only bites when the
  *cloud* runs the loop while a tool runs elsewhere. The local-loop model sidesteps
  it: when the daemon or browser runs the loop in-process, its tools run in-process
  too and only the inference calls go out (the round-trips any cloud inference pays).
  So the cost lands only if you insist the cloud run the loop with a remote tool, and
  it dissolves whenever the loop is local.

- **Time-to-first-token regresses slightly for cloud answers.** The user's own
  message echoes instantly (a local doc write), but the assistant's first token now
  waits on a relay round-trip and a DO trigger rather than a direct SSE pipe.
  Streaming granularity becomes the flush cadence (one transaction per ~75ms or 512
  chars), coarser than raw per-token SSE. zhongwen already runs this way and proves
  it is acceptable.

- **The migration risk lives in the SSE apps, not the cloud path.** opensidian and
  tab-manager render from `createChat` today (optimistic UI, the tool-approval UX,
  the tool-call state machine). Moving them to render-from-doc re-derives that from
  doc parts. This is real work and the place render-from-doc is proven or found
  wanting, so a tracer migration of one app gates the SSE deletion; SSE is removed
  only once every consumer is off it.

- **This forecloses house-key, server-inference, browser-tool chat at SSE
  latency.** That is the deliberate trade. If a future product genuinely needs it,
  it reopens one thin, explicitly-justified SSE niche rather than the general
  transport; the default is that browser-tool agents use BYOK/local inference.

## Considered alternatives

- **Keep SSE as a co-equal transport.** Rejected: two transports, two state owners,
  two persistence models, and the text-vs-tools split, all to save one relay
  round-trip on a narrow tool-interleaving case. Tidying one branch is not the win.
- **Delete the kickoff too; make the cloud a pure ambient reaction host.** Rejected:
  it loses the synchronous 402, the auth boundary, the rate-limit and abuse seam,
  and a clean metering point, and would have to write rejections into the doc.
  Harder for no gain. Billing is the clinching reason, but not the only one.
- **Force BYOK by deleting house-key inference.** Rejected: that is the revenue
  model and the "log in, manage no keys" promise. SSE deletion does not require it;
  house-key inference rides the kickoff and the doc.
- **Stream over awareness instead of the durable doc.** Rejected in
  [ADR-0020](0020-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md):
  it drops the durable mid-stream partial for a floor cost that does not exist for a
  single-writer region.

## Open questions (settle in the B1 / universal-core spec)

- **Where the billing finalize lives.** Today the policy confirms in the route
  middleware while the kickoff request stays open for the whole generation (a CF
  wall-clock ceiling, pre-existing in `runDocGeneration` + `waitUntil`). The doc
  model lets the kickoff be a short trigger that returns after the reserve, with
  `trackTokens` reconciling inside the DO reaction (Autumn is safe from that
  context). Prefer the short trigger; confirm against CF limits when building.
- **The exact reservation-keyed-to-`(responder, entry)` idempotency mechanic**, so a
  retried kickoff provably reuses the reservation rather than re-reserving.
- **Prompt-pruning of old tool-results** (the AI SDK `before-last-N` policy),
  deferred by ADR-0020; orthogonal to storage, needed only once results accumulate.
