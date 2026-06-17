# Always-On Actors Buildout: Tracker

**Date**: 2026-06-16
**Status**: In Progress
**Owner**: Braden

The living state for building toward the vision in
`20260616T225034-always-on-actors-over-synced-docs.md`. The driver prompt (below)
reads this file every run, does one slice, commits, ticks a box, and stops. This
file is STATE; the specs and ADRs are TRUTH. When they disagree, the ADRs win.

Read for invariants every slice:
- `specs/20260616T225034-always-on-actors-over-synced-docs.md` (the vision)
- `docs/adr/0013-...observing-actor.md`, `docs/adr/0012-...app-blind-anchor.md`, `docs/adr/0010-...process-boundary.md`
- `specs/20260530T100000-ai-workflows-consolidated-design.md` (CANONICAL; Model 1 / Model 2)

## Dependency Rules

```txt
V0 (build)  strictly ordered slices; do the lowest unchecked one.
V1 (build)  starts only after every V0 box is ticked. Stacks on V0.
V2 (research only) independent; advance it whenever the build track is blocked on
            my review. Writes a spec, never product code.

Invariants (never violate, every slice):
  single writer per field (client owns turn + cancel, actor owns finish)
  generationId is the idempotent assistant message id
  dispatch is at most a wake nudge, never the durable queue
  no server-to-client SSE (the actor appends to Y.Text; Yjs sync is the wire)
  tools are published actions only (no bash / file / write-SQL / raw Y.Doc)
  V2 stays research-only until I explicitly say "build V2"
```

## Slices

### V0: the observing actor (hosted sync, no Iroh, extend Zhongwen)

- [x] **V0.1** Move `generationId` from the chatDoc POST body into the pending turn in the transcript doc. `commit: 86f5730ad`
- [x] **V0.2** Child-doc observe loop in the mount runtime: actor reads the conversations table, opens + observes each transcript child doc via the bound `.docs` accessor, disposes idle ones. (Core new capability; `mount-runtime.ts` hosts only the root doc today.) `commit: 73789f93a` then refactored schema-driven (`commit: c13060107`): `mount({ actors })` derives table+guid+layout from the schema like the browser `connect()`; the app registers behavior only via a per-body factory; layout/guid can no longer disagree with the schema; only observable layouts qualify.
- [x] **V0.3** Actor claims an unanswered user turn as the SOLE designated actor and streams a FAKE deterministic response into the assistant `Y.Text`, then writes `finish`. No HTTP, no duplicate stream. Fill the per-body factory's `onChange` seam in `apps/zhongwen/mount.ts` (`actors.conversations.messages`): build per-conversation generation state in the factory body, claim on the idempotent `generationId` (existence check, not a lock), stream via `appendAssistantMessage`. Port the claim/finish logic from `packages/server/src/ai/doc-generation.ts` minus HTTP. `commit: 7acc1043e` Departures from `doc-generation.ts`: no `room.sync` update-forwarding/`drain` (the connected body persists and syncs itself, so the actor writes the live `ydoc` directly) and no `signal`/`waitUntil` (no HTTP request to outlive). The doc is the lock: existence of the assistant map keyed to `generationId` is the claim and short-circuits the actor's own streaming writes; `findActiveChatDocGeneration` serialises a turn that arrives mid-stream until the finish write wakes `onChange`. The only in-memory state is an `AbortController` so teardown stops the loop before the body is destroyed (and is the seam V0.4's durable cancel reuses).
- [x] **V0.4** Durable cancel: client writes `cancelRequestedAt`; actor observes mid-generation and writes `finish: cancelled`. (The read-back departure from `doc-generation.ts`.) `commit: 9400820bf` The field is client-owned on the user turn (single writer per field, the actor still owns the assistant finish). The actor honors two timings: mid-stream (abort + finish cancelled, checked BEFORE the answer path so it is reached even while the existence-claim would short-circuit) and pre-stream (claimed-then-finished-cancelled without streaming). `remintGeneration` clears the stale cancel so a retry is not born cancelled. `ConversationView` Stop now writes the durable cancel beside the transitional HTTP abort. Rode C1 (below). Actor behavior test deferred to C2 per the documented V0.3 precedent (the fake stream is still inline/un-injectable); the data-layer primitives (`findUnansweredTurn`, `requestCancel`, remint-clear) are fully tested in `chat-doc.test.ts`.
- [ ] **V0.5** Real inference behind `startStream(messages) => AsyncIterable<StreamChunk>`. Audit that supported model adapters (TanStack AI cloud + a local backend slot) all expose text deltas through this contract, so the append loop is backend-agnostic. `commit:` IN PROGRESS: C2 landed the backend-agnostic seam (`2ca8ddddc`): the actor moved to `@epicenter/workspace/ai` as `attachChatActor`, parameterized by a `ChatStream`, with the fake now an injected fixture and the claim->stream->finish + durable-cancel path finally tested. REMAINS to tick V0.5: C3 (share one stream/flush/finish core with the server) and the real-provider swap, which is blocked on D2 (how the always-on daemon obtains inference).

V0 done when: a phone and a desktop see the same streamed reply over hosted sync, cancel works after a disconnect, 0 duplicate streams, `bun run typecheck` + workspace tests green.

### V1: Model 1 writes + durable multi-device approval (stacks on V0)

- [ ] **V1.1** Wire the app's typed actions as agent tools (action manifest -> tool defs). Read-only `books`/query tools first. `commit:`
- [ ] **V1.2** Reuse the ai-workflows engine for bounded programs: predicate-AST selection + typed transform + dry-run on a forked Y.Doc + approve the effect. Do NOT re-derive the trust model. `commit:`
- [ ] **V1.3** Durable approval record in the conversation doc that ANY device resolves. Reconcile with `20260318T155243-tool-approval-architecture.md` (in-app, single-device); do not duplicate it. `commit:`

V1 done when: a phone requests a mutation, the actor proposes the effect, the phone approves, the mutation lands through a typed action, and the approval record survives a reconnect.

### V2: research only (parallel; does not block V0/V1)

- [ ] **V2.R** Write `specs/<new-ts>-v2-coding-actor-sandbox-and-harness.md`. No product code. Use WebSearch + DeepWiki and cite every claim. Answer: (1) sandbox choice (OpenHands swappable-workspace vs E2B/Modal/Daytona vs Docker; must mount ONLY the daemon socket + read-only mirror); (2) harness (verify pi / Codex / Claude Code / Hermes RPC + per-tool approval hook; recommend the embeddable default + adapter shape); (3) local inference behind the `startStream` contract. `commit:`

## Collapse Ledger (greenfield collapses; each rides the slice that touches its surface)

Not a separate work queue. Each entry is consumed by the build slice that already
edits that surface, so no big-bang refactor. North star: the actor model deletes
the HTTP generation path, and the doc is the only wire and the only lock.

```txt
C1  Collapse the duplicated answer predicate.  DONE (9400820bf, rode V0.4)
    doc-generation.ts (server) and apps/zhongwen/mount.ts (actor) both inline
    findLatestUserTurn -> generationId guard -> existence check -> active check.
    Extract ONE pure `findUnansweredTurn(messages, now): AnswerableTurn |
    undefined` into chat-doc.ts, beside its sibling readers (the module that owns
    the transcript shape). Both call sites collapse to `const turn =
    findUnansweredTurn(read(), now); if (!turn) return;`. NO reason-union: the
    skip reasons were the server's HTTP error taxonomy (400 vs 409) leaking into
    the actor, which only needs turn-or-nothing. The server keeps that taxonomy
    in its own HTTP wrapper while that wrapper still lives (C4 deletes it).

C2  Inject startStream; the fake becomes a fixture.  DONE (2ca8ddddc, rides V0.5)
    createChatActor's streamFakeReply is a test fixture compiled into production.
    The vision already names the seam: startStream(messages) =>
    AsyncIterable<StreamChunk>. Parameterise the actor by it; V0.3's fake is the
    injected instance, V0.5's real provider is a one-line swap. Move the actor to
    @epicenter/workspace/ai (attachChatActor) beside attachChatTranscript. This
    is also what makes the claim -> stream -> finish path testable: inject a 2-
    chunk fake, assert the doc ends [user, assistant(text, finish:completed)],
    assert a re-fire is a no-op. V0.3 shipped with no such test BY CONSTRUCTION
    (the stream was inline + un-injectable); C2 fixes the fake and the test gap
    together (they are the same defect).

C3  Share the stream/flush/finish core with the server.          rides V0.5
    Once the actor streams for real it wants doc-generation.ts's flush policy
    (FLUSH_INTERVAL_MS / FLUSH_MAX_CHARS). Collapse to one runGeneration(doc, {
    startStream, signal }); the server wraps it with the updateV2 -> room.sync ->
    drain forwarding (genuinely transport, stays server-only), the actor calls it
    on the live body. Centralises the fragile teardown invariant (abort MUST
    precede body destroy or the stream writes a destroyed Y.Doc).

C4  Delete the HTTP generation route.                            V1+ (gated on R)
    The vision says it: once every room has an actor (home daemon or a cloud
    managed actor running this same loop as a sync peer), runDocGeneration + the
    room.sync forwarding + the drain retry are dead code. Biggest deletion on the
    board. Gated on the topology/targeting decision (R / open question #1).

R   Reframe: "claim" -> "reconcile a targeted turn." (DECIDED; in ADR-0013, resolves OQ#1)
    "Claim" imported a contention model the single-actor design does not have. The
    actor is a RECONCILER (observe -> compute the missing answer -> produce it),
    like the materializers. Designation is DATA, not a race or a global config: the
    conversation ROW carries a target `actorNodeId` (written by the client that
    creates/re-points it = single writer), the durable analogue of dispatch's `to`.
    The actor's observe loop filters rows to its own node. Dispatch is the doorbell
    (ephemeral nudge), the doc is the mailbox (durable, answered on reconnect even if
    the nudge is lost).
    GRAIN = whole conversation, never per-message (an answer needs the thread's
    accumulated context/capability).
    PRIMITIVE = the binding lives on the ROW, not in the transcript. The transcript
    child doc stays pure portable content (no node identity); the row carries the
    routing. That existing row/child-doc split IS the portability seam, so the three
    operations fall out: DIRECT (write actorNodeId), REASSIGN between turns (another
    write, rewrites no history), FORK (snapshot the transcript into a new row bound
    to a different node). NOT a separate routing table (doc is the only control
    plane; no parallel source of truth).
    DEPENDS ON a node roster/picker (presence/awareness) so a client can name the
    target. FUTURE refinement: target a capability (the node with the SQLite mirror)
    over a concrete node id, resolved through that roster.
    BUILD timing: model decided now; the actorNodeId field + loop filter + picker
    are load-bearing only once a second actor exists, so execution defers (V0 has one
    node; the race is theoretical). C4 (delete the HTTP route) unblocks once this lands.
```

## Decisions Needed (agent appends here instead of guessing)

```txt
D1 (V0.2, non-blocking, confirm when convenient)
   "dispose idle ones" landed as dispose-on-row-removal + shutdown, NOT a
   timeout evictor. Reason: an idle conversation can still receive a new user
   turn later; evicting its replica on a timer means the actor stops syncing
   that room and would miss the turn. Re-opening an evicted room without that
   gap needs a signal (the dispatch wake-nudge the spec names), which is not
   built yet. So a timed evictor is correct only once the wake-nudge exists.
   Steady-state memory is currently bounded by conversation count. If that is
   too loose before the wake-nudge lands, say so and I will add an LRU cap
   (evict the least-recently-changed body past a max-open count; a capped set
   cannot miss turns the way a per-room timer can).

D2 (V0.5, BLOCKING the real-provider swap; C2 + C3 do NOT need it)
   How does the always-on actor obtain real inference behind the now-existing
   `ChatStream` seam? The app's mount factory closes over its own `startStream`,
   so this is purely "what instance does Zhongwen's daemon inject in production".
   Three candidates, none pinned by the specs/ADRs:
     (a) the daemon calls the hosted /api/ai/chat SSE route via an authenticated
         daemon fetch, parsing SSE back into StreamChunks. Reuses the route,
         billing, and BYOK/house keys, BUT it is circular for hosted Zhongwen
         (the daemon would call the cloud to write a doc it then syncs to the
         cloud) and it keeps alive the very route C4 wants to delete.
     (b) the daemon holds a provider key and calls TanStack `chat()` directly
         (same call the server route makes). Simplest text path; needs a key in
         the daemon's environment and a billing answer for hosted.
     (c) a local backend (Ollama / llama.cpp / MLX) behind the same `ChatStream`.
         The end state the vision wants ("financial facts never leave the
         machine"), but needs a local runtime present.
   The seam makes all three a one-argument swap; the question is which Zhongwen
   ships first for the V0 exit ("a phone and a desktop see the same streamed
   reply over hosted sync"). Recommendation to confirm: (b) for the V0 proof
   (direct `chat()` with a daemon key), then (c) as the privacy end state; treat
   (a) as a non-goal since it fights C4. Does that hold?
```

## Log (agent appends one line per run)

```txt
2026-06-16  tracker created; V0/V1/V2 slices defined.
2026-06-16  V0.1 (86f5730ad): generationId now rides the user turn in the doc;
            actor derives it (findLatestUserTurn), POST body drops it; retry
            re-mints via handle.remintGeneration. 525 workspace + 19 server
            tests green, server typecheck clean.
2026-06-16  V0.2 (73789f93a): the daemon child-doc observe loop. New
            attachChildDocActor (transport-agnostic loop: enumerate rows, open +
            observe each transcript via the field guid deriver, dispose on
            row-removal, flush on root destroy) + attachMountChildDocActor (the
            node-only per-body connector: clientID + disk log + cloud join,
            drain-enrolled), wired into the Zhongwen mount. onChange is the V0.3
            claim->stream->finish seam. DECISION recorded below: timeout-based
            idle eviction deferred (needs the dispatch wake-nudge to re-open
            without missing a turn). 530 workspace tests green, workspace +
            zhongwen typecheck clean.
2026-06-17  V0.2 reshaped schema-driven (c13060107) after a design grill: the
            first cut hand-wired the loop in Zhongwen's compose, re-passing
            table+guid+layout+rootDoc (all schema-owned) and letting layout and
            guid disagree silently. Now mount({ actors }) derives them from the
            schema like the browser connect(); app registers behavior only (a
            per-body factory, the V0.3 onChange seam); node connector injected
            via nodeMountRuntime().connectChildDoc; loop moved to
            document/child-doc-actor.ts. ADR-0012/0013 updated. 531 tests green.
2026-06-17  V0.3 (7acc1043e): filled the conversations.messages actor seam with
            the claim -> stream -> finish loop. onChange reads the transcript,
            claims the unanswered user turn on its idempotent generationId by
            existence (the appended assistant map IS the claim, not a lock),
            streams a deterministic placeholder reply one token-append per word,
            writes a write-once completed finish. Dropped doc-generation.ts's
            room.sync forwarding + drain (connected body self-syncs) and its
            signal/waitUntil (no HTTP). findActiveChatDocGeneration serialises
            concurrent turns; the only in-memory state is the in-flight abort
            (teardown stop + V0.4's cancel seam). zhongwen + workspace typecheck
            clean, 531 workspace tests green.
2026-06-17  V0.4 (9400820bf) + C1: durable cancel. Client owns
            cancelRequestedAt on its user turn; actor reads it back and writes
            finish: cancelled (mid-stream abort, checked before the answer path;
            and pre-stream claimed-then-cancelled). remintGeneration clears the
            stale cancel on retry. ConversationView Stop writes the durable
            cancel beside the HTTP abort. C1 rode along: extracted
            findUnansweredTurn(messages, now) to chat-doc.ts (turn-or-nothing,
            no reason-union); the actor collapsed its inline predicate to one
            call; the server keeps its 400/409 taxonomy until C4. Actor behavior
            test deferred to C2 (fake stream still inline); data-layer
            primitives fully tested. workspace + zhongwen + server typecheck
            clean, 539 workspace tests green.
2026-06-17  V0.5 IN PROGRESS / C2 (2ca8ddddc): backend-agnostic chat actor.
            Moved the per-conversation actor out of Zhongwen's mount into
            @epicenter/workspace/ai as attachChatActor, parameterized by a
            ChatStream (startStream(messages) => AsyncIterable<StreamChunk>).
            V0.3 shipped the stream inline + un-injectable so the claim ->
            stream -> finish path and the V0.4 cancel had no test BY
            CONSTRUCTION; with startStream parameterized the fake is a fixture
            (mount injects fakeChatStream) and chat-actor.test.ts now covers
            completed, re-fire no-op, RUN_ERROR -> failed, mid-stream cancel,
            pre-stream cancel, and teardown-no-finish (6 tests). Extracted
            chatDocToPrompt into chat-doc.ts. Did NOT touch the server (C3 does
            that). Appended D2: how the daemon obtains real inference (blocks
            the real-provider swap; recommendation = direct chat() with a daemon
            key for the V0 proof, local backend as the end state, NOT the cloud
            route since it fights C4). workspace + zhongwen + server typecheck
            clean, 545 workspace tests green. V0.5 stays UNTICKED: C3 + the real
            swap remain. Per the Dependency Rules the build track is now blocked
            on D2, so V2.R (research-only) is the track to advance next.
```
