# doc-as-wire chat (S1)

A runnable demonstration of the thesis behind ADR-0012 / ADR-0013: **a separate,
always-on actor answers a conversation by writing into a synced document, and
another peer watches the answer stream back — the doc is the wire.** No HTTP
request/response between client and actor, no server-sent events.

It reuses the production primitives unchanged:

- `@epicenter/sync` — the STEP1/STEP2/UPDATE wire protocol the real relay speaks.
- `attachChatTranscript` — the transcript layout (the client's user-message writer
  + observe + read).
- `attachChatActor` — the per-conversation actor behavior (observe -> claim by
  appending the assistant message -> stream deltas into the `Y.Text` -> write a
  write-once `finish`).

The only thing faked is the model: the actor injects an echo `ChatStream` instead
of Gemini. Swapping a real backend in is one argument (S5).

## The three roles, as three processes

```txt
relay.ts    the RELAY   app-blind byte router; one Y.Doc per room, fans out frames
actor.ts    the ACTOR   always-on daemon; observes the transcript, streams answers in
client.ts   the CLIENT  thin REPL; writing a turn IS the request; renders from the doc
```

## Run it (3 terminals)

```sh
# terminal 1 — the relay
bun run relay

# terminal 2 — the actor (always-on daemon)
bun run actor

# terminal 3 — you
bun run client
```

Then type in terminal 3:

```txt
> which charges are unreviewed?
you: which charges are unreviewed?
assistant: You said: "which charges are unreviewed?". (demo actor: ...)   ← streams in live
```

## What to challenge

1. **"Prove they're really separate."** Watch terminal 1: it only ever logs
   `fwd room="demo" 30b (opaque bytes)`. The relay never decodes an app field —
   the streaming tokens are just byte frames it forwards. App-blindness, visible.
2. **"Prove the doc is the source of truth."** Ctrl-C terminal 3 and restart it.
   The conversation reloads — the relay held the room; no request was replayed.
3. **"Prove it's not a 1-to-1 pipe."** Open a *second* client
   (`bun run client` in terminal 4). It shows the same live stream. No push API —
   just sync.

## Non-interactive check

```sh
bun run relay        # terminal 1
bun run actor        # terminal 2
bun run smoke        # writes one turn, waits for finish, prints it, exits 0
```

## Scope (S1)

In-memory relay (restarting it clears history — durable storage is the **anchor's**
job, a later slice). No auth, no IndexedDB, no Iroh, no real model. Deferred to
later slices: durable cancel (S3, the transcript already exposes `requestCancel`),
the `agent`-binding ignore/answer flip (S4), and real Gemini inference (S5).

Configurable via env: `PORT` (default 8787), `ROOM` (default `demo`).
