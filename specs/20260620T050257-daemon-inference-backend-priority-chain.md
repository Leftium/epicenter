# Daemon inference backend priority chain: byok ?? metered ?? placeholder

**Date**: 2026-06-20
**Status**: Draft
**Owner**: Braden
**Implements**: [ADR-0038](../docs/adr/0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) (refines [ADR-0033](../docs/adr/0033-a-conversation-has-one-transport-and-two-triggers.md); relates to [ADR-0037](../docs/adr/0037-adapter-construction-is-a-shared-leaf-package-keyed-on-the-model-catalog.md))

## One Sentence

A daemon resolves its `ChatStream` as a `??` chain over three sibling
constructors, `byok(key) ?? metered(authFetch) ?? placeholder`, so the same
always-on worker answers locally when it holds a provider key and answers on the
user's metered Epicenter account when it holds only a cloud login, with no host
code edit between the two.

## Why

Post #2118 / #2119 the construction surface is clean but the daemon's *transport*
is hardcoded: `resolveChatStream` (`apps/zhongwen/mount.ts`) is BYOK-or-placeholder
and the browser is metered-only. ADR-0033 already names the backends; nothing lets
a daemon *pick* between them. The metered arm is the browser's existing
`createEpicenterProviderChatStream`, so the only genuinely new machinery is handing
the daemon an `AuthFetch`, and the daemon already authenticates to the cloud for
sync. This unifies browser + daemon onto one metered path and turns a `switch`-shaped
host into a priority `??` chain.

## Keystone (do this first; the rest is blocked on it)

The metered arm needs `createAiChatFetch(authFetch: AuthFetch)`. The daemon mount
runtime (`packages/workspace/src/daemon/mount-runtime.ts`) holds a `session` with
`ownerId` + `openWebSocket` but exposes no HTTP `AuthFetch`. Surface the session's
existing credential as an `AuthFetch` (e.g. `session.authFetch`) alongside
`openWebSocket`. This is the one new seam; verify it before building the chain.

## Plan

Each wave independently green and revertible; separate commit per wave.

### Wave 1: Surface the daemon session credential as an `AuthFetch` (the keystone)

- [ ] **1.1** In `@epicenter/workspace/daemon`, expose the sync session's credential
  as an `AuthFetch` (the shape `@epicenter/auth` exports and `createAiChatFetch`
  wraps). Type-only at the consumer; the runtime constructs it at the host edge.
- [ ] Checkpoint: a Node smoke that the daemon's `AuthFetch` authenticates a GET
  against the cloud (same credential the WebSocket sync already uses). Commit.

### Wave 2: Name the three backends as sibling `ChatStream` constructors

- [ ] **2.1** Extract the daemon's inline `chat({ adapter, systemPrompts, abortController })`
  arm (plus the `AbortSignal` -> `AbortController` bridge) into a named
  `chatStreamFromAdapter(adapter, systemPrompts)` in `@epicenter/ai-adapters`. The
  second adapter -> `ChatStream` caller now exists, so ADR-0037's extraction gate
  has tripped; this is no longer premature.
- [ ] **2.2** `metered` is `createEpicenterProviderChatStream` (already in
  `@epicenter/client`), unchanged. `placeholder` is the daemon's `fakeChatStream`,
  unchanged. No new abstraction beyond naming the BYOK builder.
- [ ] Checkpoint: `bun run --filter @epicenter/ai-adapters typecheck`; workspace tests. Commit.

### Wave 3: Rewrite `resolveChatStream` as the priority chain

- [ ] **3.1** Replace `resolveChatStream` with `byok(key) ?? metered(authFetch) ?? placeholder`:
  read the house key (BYOK arm via `chatStreamFromAdapter` + `createAdapterForModel`),
  else build the metered arm from the daemon `AuthFetch` (Wave 1) + the catalog
  model, else placeholder. No `switch`; the `HOUSE_KEY_ENV_VAR` lookup stays for the
  BYOK arm's key read.
- [ ] **3.2** Keep the log line for the placeholder fall-through, generalized to name
  which arms were unavailable (no key and no cloud identity).
- [ ] Checkpoint: `bun run --filter @epicenter/zhongwen typecheck`; daemon smoke per
  ADR-0033 Part 1 (key set -> local reply; key unset + cloud login -> metered reply;
  neither -> placeholder). Commit.

## What we deliberately do NOT collapse

- **BYOK stays** (refuse the metered-only fork). The leaf keeps two consumers and
  remains a leaf; ADR-0037 holds. Do not fold `@epicenter/ai-adapters` into the
  server. The contingency for the metered-only fork is recorded in ADR-0038, not
  taken here.
- **The waist (`ChatStream`) and `streamAnswer` are untouched.** This spec changes
  only how a daemon *constructs* a `ChatStream`, never the loop or the doc sink.
- **The placeholder is not deleted.** It is the explicit "real inference not wired
  on this host" boundary and exercises the claim -> stream -> finish path.

## Out of scope (separable threads, do not bundle)

- **Model-as-data.** Letting a daemon answer as *any* model per conversation (the
  browser already switches model per turn via its `data()` thunk; the daemon fixes
  `ZHONGWEN_MODEL` at config) is a catalog/agent-field change, separable from this
  transport fork. Track separately.
- **Single-homing the wire contract.** `EpicenterProviderData` (client) is a
  hand-written subset of `aiChatBody.data` (server arktype). Deriving both from one
  shared schema in `@epicenter/constants` is marginal; not now.

## Invariants (hold throughout)

- One transport: the cloud never writes a conversation doc; only an in-process peer
  does (ADR-0033). This spec changes only how tokens are sourced.
- `ChatStream` stays the single sink-facing contract; `streamAnswer` is untouched.
- Existence-is-the-claim (`findUnansweredTurn`) remains the only double-answer guard.

## Verify Commands

```
bun run --filter @epicenter/ai-adapters typecheck
bun run --filter @epicenter/server typecheck
bun run --filter @epicenter/client typecheck
bun run --filter @epicenter/zhongwen typecheck
(cd packages/workspace && bun test)
bun scripts/check-doc-hygiene.ts
```

## Post-landing

When Wave 3 lands, flip ADR-0038 to `Accepted` and delete this spec per the
two-state lifecycle (git keeps the body). If the keystone (Wave 1) proves the
session cannot cheaply mint an `AuthFetch`, stop and re-grill ADR-0038's fork
before building Waves 2 to 3.
