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

The credential already exists: `MountSession.fetch`
(`packages/workspace/src/daemon/define-mount.ts:52`) is an `AuthedFetch`,
byte-identical to the `AuthFetch` that `createAiChatFetch` wraps, so
`createAiChatFetch(session.fetch)` typechecks directly: no new auth plumbing. The
gap is structural. `resolveChatStream()` runs at config-build time inside
`zhongwen({...})` (`apps/zhongwen/mount.ts`), where no session exists, and the
mount runtime forwards `ownerId` / `openWebSocket` to workers but not `fetch`. So
thread `session.fetch` to the worker factory and resolve the `ChatStream`
per-body, session in hand, instead of once at construction.

## Plan

Each wave independently green and revertible; separate commit per wave.

### Wave 1: Thread the existing session `AuthedFetch` to per-body resolution (the keystone)

- [ ] **1.1** Forward `session.fetch` from the `.mount()` coordinator
  (`SessionMountContext`) into the worker factory context (`ChildDocWorkerContext`,
  today `{ ydoc }` only), and move `resolveChatStream()` out of `zhongwen({...})`
  construction into the per-body factory so it sees the session. No new auth type:
  `createAiChatFetch(session.fetch)` typechecks directly.
- [ ] Checkpoint: a Node smoke that `session.fetch` GETs the cloud with the same
  credential sync uses. Commit.

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
