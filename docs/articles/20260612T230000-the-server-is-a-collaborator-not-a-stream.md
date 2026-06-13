# The server is a collaborator on the doc, not a stream

The benefit of using Yjs as the source of truth, instead of streaming AI tokens over TanStack AI, is that you survive full page refreshes. The server is a real-time collaborator on the document, the same as the rest of the app. It is not pushing tokens down a pipe to you; it is editing the same doc you are looking at. That is the whole trick, and it is really cool once you see it.

Here is the contrast. With SSE, the assistant's reply lives in a connection. The server generates a token, writes it to the stream, you render it. Refresh the page and the connection dies, so the half-written reply dies with it unless you separately wrote it somewhere. Persistence, multi-device live view, and resume-after-refresh are each a feature you bolt on by hand.

With doc-as-wire, the transcript is a Yjs doc, and tokens are just edits to it. The client appends the user's message:

```typescript
appendUserMessage(doc, { id, content, createdAt });
```

The server opens that same doc as a sync peer, appends an empty assistant message, and flushes deltas into it. Each flush is one Durable Object RPC that carries the diff:

```typescript
const replica = new Y.Doc({ gc: true });
const writer = appendAssistantMessage(replica, { id, createdAt });
// per ~75ms / 512-char flush:
writer.appendText(delta);
await room.sync(encodeSyncRequest(replicaStateVector, update));
```

The client never subscribes to a token stream. It observes the doc and re-renders when it changes:

```typescript
const messages: ChatDocMessage[] = readChatDocMessages(doc);
observeChatDocMessages(doc, () => { messages = readChatDocMessages(doc); });
```

Now the refresh case falls out for free. When you reload, the doc re-opens, hydrates from local IndexedDB, and syncs the rest from the room. The partial assistant text is already there on first paint, and because the server is still a peer writing into that same doc, it keeps growing. You did not resume anything. There was nothing to resume; the doc was always the truth, and you just reattached to it.

```
client                                  server (one peer among many)
append user message to doc  ----->      open same doc, append assistant msg
  (sync carries it)                       room.sync(diff) per flush
observe the doc  <-----                 finish key written once at the end
  partial text renders
  (refresh -> re-read doc -> still growing)
```

The shape of the message is plain data, decoupled from the live Y types, so both writers and the UI agree on one layout:

```typescript
type ChatDocMessage = {
  id: string;
  role: 'user' | 'assistant';
  createdAt: number;
  text: string;
  finish?: { kind: 'completed' } | { kind: 'cancelled' } | { kind: 'failed'; code: string; message: string };
};
```

A few things follow from this that surprised me. The POST that kicks off generation carries no message history, because the doc already has it; the body is just a guid and a generation id. Stop is not a control message, it is aborting the kickoff fetch, and the server finishes the turn as cancelled on its own via `waitUntil`. And liveness, the "is it still typing" state, is never stored. You derive it from how recently the doc changed. Persistence, multi-device, and refresh-resume stopped being features I had to build and became consequences of having one source of truth.

It is not free. You give up the tidy request/response mental model, and the server has to be a real sync peer, which is more machinery than an SSE pipe. Retrying an interrupted turn appends a second assistant message and leaves the partial one visible, because that is what honestly happened to the doc. Deleting a conversation orphans its doc's local storage until there is a per-row cleanup primitive. Those are real costs.

But you write the sync layer once, and then every AI surface you build on top of it resumes across refreshes, shows up live on every device, and persists, without you thinking about any of it. The server stops being something you stream from and becomes someone you collaborate with.
