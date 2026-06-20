# 0038. A daemon answers through the first inference backend it can satisfy

- **Status:** Proposed
- **Date:** 2026-06-20

## Context

ADR-0033 names three inference backends, orthogonal to who writes the doc: the
metered Epicenter provider (posts to `/api/ai/chat`, house key, billed), BYOK
(the user's own provider key), and local (a model on the machine). It never says
how a single daemon *chooses* among them. Today the choice is hardcoded per host:
the zhongwen daemon's `resolveChatStream` is BYOK-only (read the house key from
`process.env`, else a placeholder), and the browser is metered-only
(`createEpicenterProviderChatStream`). A daemon that wants to answer on the
user's metered Epicenter account, with no raw provider key on the box, has no
path, even though the daemon's signed-in `MountSession` already carries an
`AuthedFetch` (`session.fetch`) beside `ownerId` and `openWebSocket`.

This ADR refines ADR-0033: it settles how a daemon resolves which backend serves
a turn. It relates to ADR-0037, whose leaf package builds the BYOK arm's adapter.

## Decision

A daemon resolves its `ChatStream` as a priority chain over the backends it can
satisfy, not a hardcoded constant:

```txt
byok(key)              if a local provider key is present  (via @epicenter/ai-adapters)
?? metered(authFetch)  else if the daemon holds a cloud identity  (the browser's /api/ai/chat path)
?? placeholder         else  (the deterministic claim -> stream -> finish stand-in)
```

The three backends are sibling `ChatStream` constructors; the resolver is a `??`
chain, not a `switch`. The metered arm reuses the browser's
`createEpicenterProviderChatStream` unchanged; the daemon supplies its `AuthFetch`
by surfacing the credential its sync session already holds. BYOK stays (we refuse
the metered-only fork): an offline or self-hosted daemon must answer without a
cloud round-trip.

## Consequences

- A daemon's transport becomes a runtime property of what the host holds, not a
  compile-time import. A daemon with a key runs locally and free; a keyless
  daemon with a cloud login spends metered credits; a bare daemon still exercises
  the full path with the placeholder.
- The browser and the daemon share one metered constructor
  (`createEpicenterProviderChatStream`); the metered path is written once.
- `@epicenter/ai-adapters` keeps two consumers (the hosted route and the BYOK
  daemon arm), so it stays a leaf and ADR-0037 holds. Contingency, recorded so it
  is not rediscovered: if BYOK-daemon is ever dropped (the metered-only fork), the
  leaf has a single consumer and folds back into `@epicenter/server`. The leaf's
  life is contingent on two or more SDK-needing hosts.
- The "second adapter -> `ChatStream` caller" the leaf was waiting for now exists
  (the daemon's BYOK arm as a named builder), so extracting a BYOK `ChatStream`
  constructor into the leaf is no longer premature.
- Keystone, and the reason this is `Proposed` not `Accepted`: the credential
  already exists. `MountSession.fetch` is an `AuthedFetch`, byte-identical to the
  `AuthFetch` that `createAiChatFetch` wraps, so the metered arm needs no new auth
  plumbing. The gap is structural: `resolveChatStream()` runs at config-build time
  (inside `zhongwen({...})`) where no session exists yet, and the mount runtime
  forwards `ownerId` / `openWebSocket` to workers but not `fetch`. The work is to
  thread `session.fetch` to the worker factory and resolve the `ChatStream`
  per-body, with the session in hand, instead of once at construction. This ADR
  lands when that wiring exists.

## Considered alternatives

- **BYOK-only (status quo).** Simplest today, but a daemon must hold a raw
  provider key and can never answer on the user's metered account. Lost because
  ambient daemons should answer on an Epicenter login without keys on the box.
- **Metered-only.** Deletes the leaf (folds into the server) and makes the daemon
  SDK-free. Lost because it refuses offline and self-hosted inference and forces a
  cloud identity plus credit spend on every daemon. Kept as the documented
  contingency above, not the default.
