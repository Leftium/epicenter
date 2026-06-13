# Zhongwen chat over Yjs: the conversation doc is the wire protocol

**Date**: 2026-06-12
**Status**: Implemented (automated gates green; manual two-device smoke pending)
**Owner**: Braden
**Branch**: feat/zhongwen-chat-doc-as-wire (off codex/tab-manager-ai-parts-collapse)

## One Sentence

Each zhongwen conversation becomes its own synced Yjs child doc that the
server-side AI route writes assistant tokens into directly, replacing the SSE
stream, the TanStack chat client, and the chatMessages table with a single
source of truth.

## How to read this spec

```txt
Read first:       One Sentence, Current State, Target Shape, Implementation Plan,
                  Success Criteria
Architecture:     Message Shape, Derived UI State, Generation Actor
Read if unsure:   Research Findings (every load-bearing claim is verified),
                  Design Decisions, Edge Cases, Open Questions
```

## Overview

Zhongwen wants synced chat. Instead of streaming over SSE and persisting into a
CRDT table as two separate systems, the conversation transcript lives in a
per-conversation Yjs child doc and the server streams by appending to it as a
sync peer. Persistence, multi-device live view, and refresh-resume stop being
features and become consequences.

## Motivation

### Current State

Two synced tables in the root workspace doc (apps/zhongwen/zhongwen.ts:66-83):

```ts
const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	provider: field.string(),
	model: field.string(),
	createdAt: field.number(),
	updatedAt: field.number(),
});

const chatMessagesTable = defineTable({
	id: field.string<ChatMessageId>(),
	conversationId: field.string<ConversationId>(),
	role: field.select(['user', 'assistant']),
	parts: field.json(Type.Array(jsonValue)),
	createdAt: field.number(),
});
```

The client streams over SSE through `@tanstack/ai-svelte` (`createChat` +
`fetchServerSentEvents`) and writes rows at turn boundaries
(`apps/zhongwen/src/routes/(signed-in)/chat/chat-state.svelte.ts`, 354 lines).
The server route (`packages/server/src/routes/ai.ts`) receives the full message
history in the POST body and answers with `toServerSentEventsResponse`.

Problems:

1. **Dual write**: live chat-client state and stored rows must be reconciled.
   This bug family (hydration races, settle heuristics, refresh-vs-live merge)
   consumed the whole tab-manager hardening arc.
2. **Two realtime transports**: the sync websocket and the SSE channel each
   have their own auth, reconnect, and error story.
3. **No resume**: refresh mid-generation loses the stream; a second device
   sees nothing until the turn finishes.
4. **Client-assembled history**: every kickoff re-sends the entire transcript
   in the request body, and the server has to trust it.

### Desired State

```txt
client                                  server (one Cloudflare worker)
ChatInput
  append user Y.Map to chat doc  ---->  POST kickoff {guid, generationId, ...}
  (sync carries it)                       auth + ownership + billing policies
                                          room.getDoc() -> local replica
UI observes the doc            <----     append assistant Y.Map, then
  partial text renders                    room.sync(update) per ~75ms flush
  on every update                         finish key written once, 200 returned
```

The POST body carries no messages. Stop is aborting the kickoff fetch.

## Research Findings

Every claim here was verified during design (2026-06-12); the implementer can
rely on them without re-deriving, or re-check the cited source.

| Claim | Source |
| --- | --- |
| Contiguous same-client Y.Text appends merge into single Items at transaction end, so token streaming stores at roughly content size | DeepWiki yjs/yjs: `Item.mergeWith`, `tryMerge`; deletions leave merged `GC` tombstones proportional to deleted ranges |
| The Room DO already owns a live server-side Y.Doc and exposes `sync(body)` / `getDoc()` RPC | packages/server/src/room/core.ts:651-688, room/backends/cloudflare/durable-object.ts:347-363 |
| Any route reaches a room via `c.var.rooms.get(doName(ownerId, guid))` | packages/server/src/server-app.ts (rooms registry middleware), room/backends/cloudflare/registry.ts:24-46 |
| `room.sync` applies updates with origin `'http'`; body format is `encodeSyncRequest(stateVector, update)` | packages/server/src/room/core.ts:651-673, packages/sync/src/protocol.ts:162-170 |
| Per-value encryption covers tables/KV only; child-doc Y.Text is plaintext at the CRDT level, so the room (server-trusted model) can read and write it with no new key machinery, same trust level as opensidian file bodies | packages/workspace/src/shared/y-keyvalue/y-keyvalue-lww-encrypted.ts; opensidian fileContentDocs sync through rooms today |
| The Epicenter sync stack has no y-protocols awareness support | zero matches for `y-protocols/awareness` repo-wide |
| `ctx.waitUntil` is capped (~30s post-response); long out-of-band work needs a held-open request, Queue, Workflow, or DO | Cloudflare Workers limits; flagged independently by Codex consult |
| Many small DO websocket messages can overwhelm a room even at low total bytes; batch | Cloudflare DO guidance via Codex consult |
| Zhongwen chat is text-only: no tools, no approvals, no `actionsToAiTools` | apps/zhongwen/src/routes/(signed-in)/chat/chat-state.svelte.ts has none |
| Child-doc guid convention exists: `docGuid({workspaceId, collection, rowId, field})` | packages/workspace/src/document/doc-guid.ts:27-43 |

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Transcript location | 2 coherence | Per-conversation child doc, guid `docGuid({workspaceId: ZHONGWEN_ID, collection: 'conversations', rowId, field: 'messages'})` | Same pattern as opensidian fileContentDocs; conversations table stays as the cheap list |
| chatMessages table | 2 coherence | Delete, with `ChatMessageId`, `ui-message.ts` | The doc is the only transcript; no parallel store |
| Message container | 1 evidence | `Y.Array('messages')` of `Y.Map`, append-only | Chat is append-only; array position is correct for logs (yjs skill); no reordering ever |
| Liveness | 2 coherence | Derived from update recency (~3s grace window), never stored | A stored `status: 'streaming'` wedges after a crash and needs repair-on-read; awareness is not in the stack and times out at ~30s anyway |
| Terminal state | 2 coherence | Single `finish` union key, written at most once by the server | Status+error as separate keys re-creates invalid state combinations; absence of `finish` plus no recent updates derives "interrupted" honestly |
| Control plane | 2 coherence | HTTP only: kickoff POST; stop = abort the kickoff fetch | Auth and billing already live on the route; durable doc keys as RPC (`stopRequested`) are ghosts that replay from offline devices |
| Generation lifetime | 3 taste | v1 holds the kickoff request open for the whole generation | Zero new infra; client abort = cancel; `waitUntil` writes the `cancelled`/`failed` finish on disconnect. Constraint: generation dies if the requester's tab closes. Revisit when turns outgrow request limits or background generation matters |
| Streaming granularity | 1 evidence | First chunk flushes immediately, then one transaction per 75ms or 512 chars, whichever first | Storage is identical either way (items merge); the cost axis is frames + DO message handling + observer churn |
| Idempotency | 2 coherence | Client mints `generationId`; the assistant message id IS the generationId; duplicate kickoff is a no-op 409 | Codex consult; retries must not duplicate messages or charges |
| Concurrency | 2 coherence | One active generation per conversation, enforced by the actor against its replica | Overlapping assistant turns are not a product feature |
| Prompt snapshot | 2 coherence | Frozen at kickoff from the server's replica | Mid-generation edits must not change the in-flight prompt |
| provider/model columns | 3 taste | Keep on the conversations table | They already exist and the kickoff body needs them. Revisit when: zhongwen wants one global model choice like opensidian's `modelChoice` KV |
| List recency | 1 evidence | The sending client bumps `conversations.updatedAt` | The conversations table is per-value encrypted; the server cannot write it. Assistant tokens never touch the root doc |
| TanStack AI on this path | 2 coherence | Server-side only (`chat()` + provider adapters); the zhongwen client drops `@tanstack/ai-svelte` entirely | The client is an input box plus a doc observer |

## Architecture

### Message Shape

```ts
// Y.Array('messages') in the chat child doc; one Y.Map per message.
// Single writer per map: the creating client for user messages,
// the generation actor for assistant messages.
type ChatDocMessage = {
	id: string;            // assistant: the generationId
	role: 'user' | 'assistant';
	createdAt: number;
	content: Y.Text;       // token appends land here
	finish?:               // server, written at most once; absence = not terminal
		| { kind: 'completed' }
		| { kind: 'cancelled' }
		| { kind: 'failed'; code: string; message: string };
};
```

### Derived UI State

```txt
finish present                          terminal (render kind; failed.code
                                        'insufficient-credits' drives the
                                        upgrade CTA)
no finish + update in last ~3s          streaming (caret)
no finish + quiet past grace window     interrupted (crash artifact; offer retry)
empty trailing assistant + recent       thinking (actor pushed the map before
                                        the first token)
```

No state machine is stored anywhere. The ownership table:

```txt
concern    owner          why
content    chat doc       durable, the product artifact
liveness   derived        from update recency; storing it wedges
control    HTTP route     kickoff and abort; auth + billing live there
outcome    finish union   durable fact, one writer, one write
listing    conversations  table row (title, provider, model, timestamps),
                          bumped by the sending client
```

### Generation Actor (server)

New module in `packages/server` (suggested: `src/ai/doc-generation.ts`),
invoked from a new route handler mounted beside the existing SSE route with the
same `auth`, `createRequireOwnership`, and billing `policies` chain
(packages/server/src/routes/ai.ts:137-153):

```txt
POST /api/.../ai/chat/doc   body: { guid, generationId, provider, model,
                                    systemPrompts?, apiKey? }

1. room = c.var.rooms.get(doName(ownerId, guid))
2. getDoc() -> Y.applyUpdateV2 into a local replica
3. validate: guid parses as a zhongwen conversation messages doc;
   no assistant message with id === generationId (else 409);
   no trailing assistant message without finish whose createdAt is inside a
   staleness window of ~2 minutes (else 409). A snapshot cannot know "still
   live", so staleness stands in for it: an unfinished turn older than the
   window is an interrupted artifact and does not block a new generation
4. snapshot the prompt: messages array -> ModelMessage[] (text content,
   role mapping; systemPrompts from body)
5. append assistant Y.Map { id: generationId, role, createdAt, content }
6. stream = chat({ adapter, messages, abortController }) as today
7. forward every local transaction to room.sync(encodeSyncRequest(sv, update));
   capture update bytes from doc.on('updateV2') per flush transaction.
   sv MUST be the replica's own current state vector: an empty one would make
   the room echo the entire doc back as the diff on every flush
8. flush policy: first chunk immediately, then 75ms / 512 chars
9. on completion: set finish { kind: 'completed' }, respond 200
   on abort signal (client stopped or disconnected): cancel provider stream,
   write finish { kind: 'cancelled' } inside ctx.waitUntil
   on provider/billing error: write finish { kind: 'failed', code, message }
   with a sanitized message; details go to logs
```

The actor never reads updates back mid-generation; user messages appended
concurrently from other devices commute and join the next turn's snapshot.

### Client (zhongwen)

```txt
conversations list   fromTable(zhongwen.tables.conversations)  (unchanged)
active chat          createDisposableCache(conversationId =>
                       child doc + attachLocalStorage + openCollaboration)
                     copied from opensidian fileContentDocs
                     (apps/opensidian/opensidian.browser.ts:60-94)
messages             observer on Y.Array('messages') -> reactive list
send                 append user Y.Map; bump conversations.updatedAt and
                     title-from-first-message; POST kickoff with a fresh
                     generationId; hold the AbortController for stop
stop                 abort the kickoff fetch
deleted              createChat, fetchServerSentEvents, ui-message.ts,
                     chatMessages reads/writes, @tanstack/ai-svelte import
```

## Call Sites: before and after

**Send** (`chat-state.svelte.ts`, current shape mirrors opensidian's old one):

```ts
// Before: dual write
void chat.sendMessage({ content, id: userMessageId });
zhongwen.tables.chatMessages.set({ id: userMessageId, conversationId, ... });

// After: one write plus a control call
doc.messages.push(userMessage(content));          // the only transcript write
zhongwen.tables.conversations.update(conversationId, { updatedAt: Date.now() });
void kickoffGeneration({ guid, generationId, provider, model, signal });
```

**Server route** (`packages/server/src/routes/ai.ts:61-111`):

```ts
// Before: history arrives in the body, response is the stream
const { messages, data } = c.req.valid('json');
return toServerSentEventsResponse(chat({ adapter, messages, ... }));

// After: history comes from the room, response is just the request lifetime
const { guid, generationId, data } = c.req.valid('json');
const room = c.var.rooms.get(doName(c.var.ownerId, guid));
return runDocGeneration({ room, generationId, adapter, ... }); // 200 at the end
```

**Semantic shift to flag**: the client no longer learns errors from an SSE
error frame; it learns them from the `finish` key syncing back. Anything in the
old client that branched on `chat.error` must rebind to the trailing message's
`finish`.

## Implementation Plan

Build, prove, remove: the old SSE path stays alive until the new path is
verified end to end.

### Phase 1: server generation actor

- [x] **1.1** `packages/server/src/ai/doc-generation.ts`: local-replica
      actor (getDoc, validate, append, flush loop, finish key) with the flush
      policy above; unit-tested against `createRoomCore` directly with a fake
      adapter (the room core is runtime-agnostic and already test-covered)
- [x] **1.2** New route `POST` beside the SSE route, same mount chain
      (auth, ownership, billing policies); body schema with arktype matching
      the existing `aiChatBody` minus `messages`, plus `guid` + `generationId`
- [x] **1.3** Idempotency and single-generation 409 paths, tested

### Phase 2: zhongwen client

- [x] **2.1** Child-doc cache in `zhongwen.browser.ts` (single cache that
      creates the transcript doc + attachLocalStorage + openCollaboration;
      see divergence 1)
- [x] **2.2** Rebuild `chat-state.svelte.ts`: doc-observing message list,
      send/stop as above, derived liveness, finish rendering
- [x] **2.3** Delete `ui-message.ts`; drop `@tanstack/ai-svelte` (and the
      now-dead `@tanstack/ai-client`, `@tanstack/ai`, `@tanstack/ai-anthropic`)
      from zhongwen's package.json

### Phase 3: prove

- [x] **3.1** `bun run --cwd packages/server test` (109 pass),
      `bun run --cwd packages/workspace test` (476 pass), and the four app
      typechecks (zhongwen, tab-manager, opensidian, api) all green
- [ ] **3.2** Manual smoke: two browser profiles, same account; send from one,
      watch tokens land on both; refresh mid-generation; abort mid-generation
      (requires a running worker + live OAuth/provider keys; not runnable
      headless)

### Phase 4: remove

- [x] **4.1** Deleted the `chatMessages` table, `ChatMessageId` and its
      generator/caster, and `ui-message.ts`. No remaining SSE chat usage in
      zhongwen (tab-manager and opensidian keep the SSE route; untouched)

## Edge Cases

- **Kickoff retry**: same `generationId` arrives twice (network retry).
  Second call sees the assistant map already exists, returns 409, writes
  nothing, charges nothing.
- **Two devices send simultaneously**: both user maps land (commutative
  appends); two kickoffs race; the single-generation check serializes them,
  the loser 409s and the client re-kicks after the first finishes.
- **Requester closes the tab mid-generation**: request aborts; `waitUntil`
  writes `finish: cancelled`. Other devices see a cancelled partial turn.
- **Worker eviction mid-generation**: no finish ever lands; clients derive
  "interrupted" after the grace window and offer retry.
- **Offline send**: the user map syncs later but the kickoff fails
  immediately; the input surfaces the failure. v1 requires being online to
  generate (matches SSE behavior today).
- **Out of credits**: billing policy rejects the kickoff before any doc write
  (pre-generation), or the actor writes `finish: failed` with code
  `insufficient-credits` (mid-generation), driving the upgrade CTA.
- **Deleting a conversation orphans its transcript doc** (deferred). Deleting
  the conversations row drops the list entry and disposes the in-memory doc
  handle, but the child doc's local IDB database and its relay room are left
  in place: there is no per-row local-IDB cleanup primitive
  (`createOwnedYjsKey` is package-private, the disposable cache has no
  per-entry evict) and no relay room-deletion endpoint for any app. Same
  property the superseded message-docs design had; no inert data exists today
  because no doc was created with either shape. Revisit when a privacy
  requirement or storage pressure makes orphaned ciphertext unacceptable; a
  prefix-enumeration sweep is the likely shape (the guid grammar is
  right-recoverable, `doc-guid.ts`).

## Open Questions

1. **Regenerate**: (a) append a fresh assistant message and leave the old
   turn visible, (b) supersede pointer, (c) delete the old map (small
   tombstone). **Recommendation**: ship v1 without regenerate; add (a) first
   if wanted, it needs no new schema.
2. **Route naming**: `/ai/chat/doc` vs a resourceful
   `/ai/conversations/:guid/generations`. **Recommendation**: whatever fits
   `API_ROUTES`' existing flat style; not load-bearing.
3. **Does the SSE route eventually die for all apps?** Tab-manager's
   local-model `fetcher` path and opensidian's device-flavored choices keep it
   alive for now. Revisit if zhongwen's shape proves out and the others want
   sync.

## Success Criteria

- [ ] Two signed-in devices see assistant tokens stream live from one send
      (manual; pending)
- [ ] Refresh mid-generation: partial text is present and keeps growing
      (manual; pending)
- [ ] Abort mid-generation: `finish: cancelled` lands; UI settles (manual;
      pending)
- [ ] Kill the worker mid-generation (dev): UI derives interrupted after the
      grace window; retry works (manual; pending)
- [x] No `chatMessages` references anywhere; zhongwen has no
      `@tanstack/ai-svelte` import
- [x] Full verification suite green (four app typechecks, packages/server and
      packages/workspace tests)

## Divergences from the spec

1. **One child-doc cache, not two layers.** The spec said copy the opensidian
   `fileContentDocs` composition verbatim, which is a two-layer cache (an
   inner cache in `createOpensidian` that other runtimes also consume, wrapped
   by an outer sync cache in the browser). Zhongwen has only one consumer (the
   browser sync wrapper), so the inner isomorphic cache would be unearned
   indirection. Collapsed to a single `conversationDocs` cache in
   `zhongwen.browser.ts` that mints the doc directly; `zhongwen.ts` keeps only
   `zhongwenConversationDocGuid` (isomorphic, names the doc for both the client
   and the kickoff body). Revisit if a daemon materializer ever needs to read
   transcripts.
2. **Generation lifetime carries `updatedAt` on completion.** The spec's
   "sending client bumps `updatedAt`" is realized as: the requester bumps on
   send (title + recency) AND again when the kickoff fetch resolves 200 (the
   finish signal). The server cannot write the per-value-encrypted
   conversations table, and a completed reply can only land while the
   requester is alive (its `waitUntil` cancels otherwise), so the requester is
   the reliable owner of completion recency.
3. **Three 409 error variants, not a generic one.** `GenerationAlreadyExists`
   (idempotency), `GenerationInProgress` (single active generation), and
   `NoUserMessage` (kickoff beat the user message into the room) are distinct
   `AiChatError` variants so the client can branch without parsing prose.
4. **Dropped four dead TanStack AI deps, not one.** `@tanstack/ai-svelte`,
   `@tanstack/ai-client`, `@tanstack/ai`, and `@tanstack/ai-anthropic` were all
   unused after the rebuild (`@tanstack/ai`/`-anthropic` were already dead
   before this work). The provider model-list packages (`-openai`, `-gemini`,
   `-grok`) stay.

## References

- `packages/server/src/room/core.ts` - room sync/getDoc surface the actor uses
- `packages/server/src/room/backends/cloudflare/registry.ts` - how routes reach rooms
- `packages/server/src/routes/ai.ts` - existing SSE route; mount chain to copy
- `packages/sync/src/protocol.ts` - `encodeSyncRequest` body format
- `packages/workspace/src/document/doc-guid.ts` - child doc guid convention
- `apps/opensidian/opensidian.browser.ts:60-94` - child-doc cache composition to copy
- `apps/zhongwen/zhongwen.ts`, `apps/zhongwen/zhongwen.browser.ts` - schema and composition to change
- `apps/zhongwen/src/routes/(signed-in)/chat/` - client chat code to rebuild
- `specs/20260612T121815-opensidian-chat-as-note.md` - the sibling decision for opensidian; divergence is deliberate
