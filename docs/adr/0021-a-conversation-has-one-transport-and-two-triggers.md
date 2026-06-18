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

A conversation has **one transport and two triggers**. Every answerer, in every
runtime, streams parts into the synced child doc (ADR-0019's reply regions,
ADR-0020's parts body); the client always renders the doc and never receives SSE.
The **SSE route is deleted.** Answerers differ only in *where the loop runs and
where its tools execute*, and in how they are *triggered*:

```txt
transport (how the answer arrives):  the synced doc.            ONE. SSE deleted.
trigger   (how the answerer starts): cloud  -> a billed kickoff (hosted-only)
                                     daemon -> ambient observe of the doc (free)
                                     BYOK   -> the browser's own loop (free)
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

- **Deleting SSE does not force BYOK.** House-key managed inference (log in, manage
  no keys) is the *cloud* runtime and survives untouched: it is the billed product,
  reached through the kickoff, answered into the doc. The three runtimes line up
  with the business model exactly. Cloud (house key) is billed at the kickoff; BYOK
  browser and self-hosted daemon are free by construction. SSE deletion is
  orthogonal to all of it.

- **BYOK and self-host stay free, and share the kickoff branch crisply.** A BYOK
  cloud call carries the user's key and bypasses billing (the policy already skips
  on `apiKey`); a daemon or BYOK-browser conversation never fires the kickoff at
  all. The hosted-only billing policy is injected via `mountAiApp`; self-host passes
  none. The `personal()` / `shared({ admit })` deployment seam is untouched.

The doctrine is one sentence: *a conversation is a synced doc that every answerer
streams parts into; the client renders the doc, never SSE; the cloud answerer is
triggered by a billed kickoff, and every answerer the user runs is free and
ambient.*

## Consequences

- **The deletion prize is a whole transport plus its duplicates.** Gone: the SSE
  route and `toServerSentEventsResponse`; the browser's in-memory `createChat` as
  the source of truth (render the doc instead); the text-only-vs-tools split
  (ADR-0020); dual persistence (the doc is the one store); the transport fork in the
  browser. `runDocGeneration` becomes the cloud-runtime call of one shared core, and
  `chat-reaction.ts`'s bespoke reduction becomes the TanStack loop plus a doc-sink
  (the B1 / Phase-3 work, designed as the universal core, not a cloud/daemon dedup).

- **Wins beyond dedup.** Every tab and device renders one stream from the shared
  doc instead of fragmenting per in-memory client. A turn bound to an offline
  daemon waits in the doc until that daemon wakes (SSE cannot queue). And there is
  one conversation primitive to test.

- **The one accepted cost: a relay round-trip for remote tools.** House-key
  inference plus a *browser-side* tool plus interactive approval, all in one turn,
  was the single thing SSE did better: the open connection interleaved
  server-inference and browser-tool-execution at low latency. Under the doc model
  that interleaving still works (the cloud reaction writes a tool-call part, the
  browser runs the tool and writes a tool-result part back, the reaction continues),
  but each tool round-trip goes through the relay instead of an open channel. For a
  local-first app where tools run where their data lives, this latency is accepted,
  not a reason to keep a second transport. It dissolves entirely when a browser
  agent runs inference locally (BYOK), because then the whole loop is local.

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
