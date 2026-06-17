# 0013. Agent conversations are durable child docs driven by an observing actor

- **Status:** Proposed
- **Date:** 2026-06-16

## Context

Doc-as-wire chat (Zhongwen) already streams an assistant turn into a conversation
child doc by acting as a sync peer, so persistence, multi-device live view, and
refresh-resume fall out of one source of truth rather than separate features. But
it still needs an HTTP kickoff carrying the turn id, model, and prompts; the actor
snapshots the prompt once and never reads the doc back; cancellation is request
abort; and interactive tools are excluded. None of that survives moving the actor
to a user-owned always-on device (see [ADR-0012](0012-an-always-on-actor-runs-app-semantics-beside-the-app-blind-anchor.md))
or running it as a durable background service.

## Decision

An agent turn is a durable record in the conversation transcript (a child doc keyed
by a `conversations` row), not an HTTP request. The unanswered user message is the
work queue; there is no separate request table.

Designation is data, not a race or a global config. The conversation row carries a
target `actorNodeId`, written by the client that creates or re-points the
conversation (single writer), the durable analogue of a dispatch request's `to`.
Each actor reconciles the conversations targeted at its own node: it observes their
transcripts, answers any unanswered turn, and is idempotent through the durable
client-minted `generationId` used as the assistant message id. There is no claim and
no race, because exactly one node is named per conversation (and CRDT merges could
not enforce a claimant anyway). The transcript child doc holds no node identity, so
it stays portable content while the binding lives on the row; that row/child-doc
split is the portability seam.

The actor observes the transcript mid-answer so it can honor a durable, client-owned
cancel field, and it writes the write-once `finish`. Tool calls are the workspace's
published actions ([ADR-0010](0010-actions-are-the-only-surface-that-crosses-a-process-boundary.md));
when a call needs approval, the approval is a durable record in the doc that any
device resolves, not an in-process prompt. Dispatch is an optional wake nudge (the
doorbell), never the durable queue (the doc is the mailbox).

## Consequences

- Refresh-resume, multi-device live view, offline-survivable cancel, and
  multi-device approval all fall out of one source of truth. No server-to-client SSE
  is built: the actor appends to a `Y.Text` and Yjs sync is the transport. Only the
  model-to-actor token stream remains, and that is in-process for local inference.
- The actor gains a child-doc observe loop (a new mount-runtime capability) and a
  read-back path (a departure from the snapshot-once, write-only actor in
  `packages/server/src/ai/doc-generation.ts`). The loop hosts a live replica of
  each registered child doc, observes it, and tears it down when its row is gone.
  The app registers the conversation field on the mount; the per-body factory it
  supplies returns `{ onChange, [Symbol.dispose] }`, and `onChange` is the seam
  where answer, stream, and write-once `finish` live. Whether a turn is unanswered
  is a pure reader over the transcript snapshot (`findUnansweredTurn`), owned by the
  transcript layout module beside its sibling readers, so the actor and the
  transitional HTTP path share one predicate instead of inlining it twice. The
  factory runs once per body, so the only per-conversation state it holds is the
  in-flight stream (its abort), not a claim.
- The single-answerer guarantee is enforced on both sides of the transition, not by
  a lock. The observe loop hosts a live replica only of the conversations whose
  `actorNodeId` equals the daemon's node id, so the actor is built and runs only for
  those: filtering the open set, not abstaining after the fact, is what keeps the
  app-aware actor out of the app-blind anchor's availability job
  ([ADR-0012](0012-an-always-on-actor-runs-app-semantics-beside-the-app-blind-anchor.md)).
  The actor itself carries no designation concept. The browser supplies the
  complementary half: it skips its transitional HTTP kickoff whenever `actorNodeId`
  is set. So a designated conversation is answered only by its daemon and a
  cloud-default one (`actorNodeId` null) only by the HTTP path; neither ever answers
  a turn the other does. This is what unblocks deleting the HTTP route (C4) and
  co-deploying a daemon.
- The conversation is a row plus a transcript child doc, and that split is the
  portability seam. Directing a chat at a device is a write of `actorNodeId` on the
  row; reassigning it between turns is another write and rewrites no history
  (assistant turns carry no node identity); forking a chat to run the same history
  against a different node snapshots the transcript into a new row bound to that
  node. Naming a node needs a roster, so targeting depends on presence/awareness; a
  later refinement can target a capability (the node holding the SQLite mirror)
  instead of a concrete node id, resolved through that same roster.
- This is the conversation and transport layer. The bulk-mutation trust model
  (emit bounded data, dry-run on a forked Y.Doc, approve the computed effect) is
  Model 1 of the AI-workflows consolidated design and is unchanged here.
  Arbitrary-code agents are that design's Model 2 lane.
- Forecloses a `generation_requests` table, a CRDT claim field (CRDT merges cannot
  enforce a single claimant), and runtime claim-pools (deferred until N
  interchangeable actors per room actually exist, and then via a compare-and-set
  action, not a raw field).

## Considered alternatives

- **Keep the HTTP kickoff.** Rejected: an open request is not durable, cannot move
  to an always-on device, and cannot survive disconnect.
- **A durable `generation_requests` table.** Rejected: the unanswered turn already
  encodes the work; a parallel table is a second source of truth to reconcile.
- **A Yjs claim field per turn.** Rejected: CRDT merges cannot enforce a single
  claimant, so two actors both "win"; a per-conversation target node plus an
  idempotent id is sufficient and simpler.
- **A separate table mapping conversations to actor nodes.** Rejected: the doc is
  the only wire and control plane (no side channel), and a parallel table is a
  second source of truth to reconcile, the same reason the `generation_requests`
  table was rejected. The row already syncs to every device and to the actor's
  filter, so the binding belongs on it.
- **Per-message targeting.** Rejected: an answer needs the thread's accumulated
  capability and context, so the binding is whole-conversation; a turn never picks
  its own actor.
