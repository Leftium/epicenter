# `DocumentBundle.whenReady`: typed extension point for bundle readiness

**Date**: 2026-04-24
**Status**: Draft
**Author**: AI-assisted

## One-sentence thesis

> Add `readonly whenReady?: Promise<unknown>` to `DocumentBundle`. That is the entire framework change.

## Overview

The framework already has everything it needs for readiness composition — every attach function already constructs synchronously, exposes its own `when<X>` promise, and accepts `waitFor` for init ordering where it matters. Bundle authors already compose readiness in their closure when they care about it. The only missing piece is a **typed extension point on the contract** so consumers (notably the CLI) can read `handle.whenReady` without a TypeScript diagnostic.

This spec does nothing else. No self-gating, no method wrapping, no `registerReadiness`, no async factory, no `composeReadiness` helper. Just one optional field on the type.

## Motivation

### Current state

The CLI reads `handle.whenReady` to wait for bundle readiness before invoking:

```ts
// packages/cli/src/commands/run.ts:87
if (entry.handle.whenReady) await entry.handle.whenReady;
```

But `whenReady` is not declared on `DocumentBundle`. The guard hits a TS diagnostic on both the `if` check and the `await` branch:

```
Property 'whenReady' does not exist on type 'DocumentHandle<DocumentBundle>'.
```

Meanwhile, bundle authors who *do* compose readiness have to add the noise of `.then(() => undefined)` because there's no declared type, or because `Promise.all(...)` returns a tuple-typed promise that doesn't satisfy `Promise<void>`:

```ts
// playground/opensidian-e2e/epicenter.config.ts (today)
const whenReady = Promise.all([
    persistence.whenLoaded,
    unlock.whenChecked,
    sync.whenConnected,
]).then(() => {});   // ← noise
```

### Problems

1. **CLI has a persistent TS diagnostic** on the `handle.whenReady` access. Not fatal, but indicates the contract is incomplete.

2. **Authors write `.then(() => undefined)` noise** to adapt `Promise.all(...)` to the implicit `Promise<void>` they think they need. The noise has no semantic value.

3. **The framework has no documented extension point** for "bundle exposes a readiness barrier." Authors can add `whenReady`, but they're guessing at shape and consumers are guessing at whether it's there.

### Desired state

```ts
// packages/workspace/src/document/types.ts
export interface DocumentBundle {
    readonly id: string;
    readonly ydoc: Y.Doc;
    readonly whenReady?: Promise<unknown>;   // ← new
    [Symbol.dispose](): void;
}
```

```ts
// Bundle authors use native Promise shapes — no .then(() => undefined) noise:
return {
    ydoc, tables, persistence, unlock, sync,
    whenReady: Promise.all([
        persistence.whenLoaded,
        unlock.whenChecked,
        sync.whenConnected,
    ]),   // ← Promise<[void, void, void]> assignable to Promise<unknown>
};
```

```ts
// CLI — no TS diagnostic, no guard ceremony:
await entry.handle.whenReady;   // optional chaining implicit in await-undefined
```

## Research Findings

### Every attach function already constructs synchronously

| Attachment | Construction | Background work | Readiness signal |
| --- | --- | --- | --- |
| `attachSqlite` / `attachIndexedDb` | sync | applies saved updates | `whenLoaded` |
| `attachSync` | sync | `await waitFor` → connect WS | `whenConnected` |
| `attachSessionUnlock` | sync | `await waitFor` → load session → apply keys | `whenChecked` |
| `attachEncryption` | sync | `applyKeys()` is sync | — |
| `attachTables` / `attachKv` | sync | none | — |
| `attachAwareness` | sync | none | — |
| `attachMarkdownMaterializer` / `attachSqliteMaterializer` | sync | `await waitFor` → flush/DDL | `whenFlushed` |
| `attachRichText` / `attachPlainText` / `attachTimeline` | sync | none | — |

**Implication**: the author's closure is already fully synchronous. No `await` is needed at any attach site. The factory can stay sync; builders can stay sync; `factory.open()` can stay sync.

### Pre-hydration writes merge correctly (deepwiki-verified)

> `Y.applyUpdate()` merges with existing in-memory state via integration into the CRDT's `StructStore`; it does not replace or overwrite.

A write made before `persistence.whenLoaded` resolves enters Y.Doc's update log; when persistence later calls `Y.applyUpdateV2(ydoc, savedBlob)` (see `attach-sqlite.ts:68`), the saved state merges with the in-memory write. **Pre-hydration writes are safe.**

### Pre-unlock encrypted writes store plaintext (codebase-verified)

`y-keyvalue-lww-encrypted.ts:199-247` stores plaintext when no keys are present. `activateEncryption()` (line 324-387) re-encrypts every entry when keys arrive. Tested at `y-keyvalue-lww-encrypted.test.ts:376-398` ("passthrough then encrypted"). **Pre-unlock writes are safe.**

### Why these findings matter to this spec

Earlier drafts considered self-gating every read/write method (turning sync methods async) to force correctness. The Yjs CRDT + encryption passthrough findings show **writes don't need any framework intervention** — Yjs already handles them. And reads that run pre-hydration returning empty data are the author's problem to manage (by exposing `whenReady` for consumers to await), not a correctness bug the framework must enforce.

**Conclusion: no method-wrapping is warranted.** The framework only needs to give authors a typed place to expose readiness. That's the one-line change in this spec.

## Design Decisions

| Decision | Choice | Rationale |
| --- | --- | --- |
| Where readiness composition happens | Author's closure, in plain JS | Every attachment already constructs sync and exposes its own readiness signal. JS gives authors full composition power via `Promise.all`, `Promise.race`, conditionals, whatever. Framework prescribing a composition API would be redundant. |
| `whenReady` typed as | `Promise<unknown>` | Widest useful type. `Promise.all([...])`, `Promise.resolve()`, and any domain-specific promise all assign directly. Consumers `await` for side effect; discarding `unknown` is natural. `Promise<void>` would force `.then(() => undefined)` ceremony. |
| Optional vs required | Optional (`whenReady?: Promise<unknown>`) | Bundles without async init (in-memory tests, minimal bundles) don't need it. UIs that observe rather than wait don't need it. Making it required would force trivial `Promise.resolve()` on every bundle. |
| Helper (`composeReadiness`) | Not added | `Promise.all([a, b, c])` reads as clearly as `composeReadiness(a, b, c)` and doesn't introduce indirection. JS literate readers don't need the sugar. |
| Self-gating methods (reads/writes become async) | Not added | Yjs CRDT + encryption passthrough handle pre-ready writes; pre-ready reads returning empty is a caller concern, solved by exposing and awaiting `whenReady`. Method-wrapping costs the API surface and Svelte reactive ergonomics for correctness the framework doesn't need to enforce. |
| `registerReadiness` / ydoc collector | Not added | Implicit framework magic. Authors already have direct access to each attachment's signal in the closure. |
| Async `factory.open()` | Not added | Would block UI-oriented bundles. Sync factory preserves the "open handle immediately, init continues in background, subscribe for updates" pattern UIs rely on. |
| CLI's redundant `sync.whenConnected` await in `invokeRemote` | Delete | `sync.rpc()` already self-gates on its own `waitFor` (`attach-sync.ts:718-723`). The explicit CLI-side await is redundant. |

## Architecture

### The composition surface is the closure

```
┌─────────────────────────────────────────────────────────────────────┐
│ createDocumentFactory((id) => { … })                                │
│                                                                     │
│   const ydoc = new Y.Doc({ guid: id });                             │
│   const persistence = attachSqlite(ydoc, { … });    ← sync          │
│   const unlock = attachSessionUnlock(encryption, {                  │
│       waitFor: persistence.whenLoaded,              ← sync          │
│   });                                                               │
│   const sync = attachSync(ydoc, {                                   │
│       waitFor: Promise.all([                        ← sync          │
│           persistence.whenLoaded,                                   │
│           unlock.whenChecked,                                       │
│       ]),                                                           │
│   });                                                               │
│   const tables = attachTables(ydoc, schemas);       ← sync          │
│                                                                     │
│   return {                                                          │
│       ydoc, tables, persistence, unlock, sync,                      │
│       whenReady: Promise.all([                      ← author's      │
│           persistence.whenLoaded,                     composition   │
│           unlock.whenChecked,                         if they care  │
│           sync.whenConnected,                                       │
│       ]),                                                           │
│   };                                                                │
│ }                                                                   │
└─────────────────────────────────────────────────────────────────────┘
                    │
                    ▼ factory.open(id) returns sync handle:
┌─────────────────────────────────────────────────────────────────────┐
│ DocumentHandle<DocumentBundle>                                      │
│   ├── ydoc, tables, persistence, unlock, sync                       │
│   └── whenReady?: Promise<unknown>   ← typed extension point        │
└─────────────────────────────────────────────────────────────────────┘
                    │
      ┌─────────────┴──────────────┐
      ▼                            ▼
┌──────────────────┐      ┌──────────────────────────────┐
│ CLI:             │      │ UI apps:                     │
│ await handle.    │      │ handle.tables.foo.observe(…) │
│   whenReady;     │      │ — subscribe; don't care      │
│ invoke action    │      │   about whenReady.           │
└──────────────────┘      └──────────────────────────────┘
```

## Implementation Plan

### Phase 1: Add the typed extension point

- [ ] **1.1** Add `readonly whenReady?: Promise<unknown>` to `DocumentBundle` in `packages/workspace/src/document/`. (Likely in `create-document-factory.ts` or a `types.ts`; verify during implementation.)
- [ ] **1.2** Verify `DocumentHandle<DocumentBundle>` inherits the field via its spread typing. No change expected; TS should pick it up automatically.
- [ ] **1.3** Update `packages/workspace/README.md` and `.claude/skills/workspace-api/SKILL.md` to document `whenReady` as an optional extension point. Show the `Promise.all(...)` pattern without `.then(() => undefined)`. Note that bundles intended for CLI use should expose it.

### Phase 2: CLI cleanup

- [ ] **2.1** The TS diagnostic on `packages/cli/src/commands/run.ts:87` (`if (entry.handle.whenReady) await entry.handle.whenReady`) resolves automatically once the type is declared. Verify and simplify to `await entry.handle.whenReady` if the falsy guard is still meaningful (awaiting `undefined` is a no-op).
- [ ] **2.2** Delete `if (sync.whenConnected) await sync.whenConnected;` in `invokeRemote` (`run.ts:163`). `sync.rpc()` already self-gates on its own `waitFor`; this line is redundant.

### Phase 3: Optional bundle cleanup

- [ ] **3.1** `playground/opensidian-e2e/epicenter.config.ts`: drop the `.then(() => undefined)` tail on the `Promise.all(...)` composition. The type widening makes it unnecessary.

## Edge Cases

### Bundle doesn't expose `whenReady`

CLI's `await entry.handle.whenReady` resolves to `undefined` (no-op). CLI invokes against a handle whose background init may not have completed. Pre-hydration reads return empty state; the action author sees empty data. This is intentional: bundles that care about CLI correctness expose `whenReady`; bundles that don't (test doubles, in-memory) don't have to.

### Author composes `whenReady` incorrectly (forgets an attachment)

The framework can't catch this. Authors are responsible for composing what "ready" means for their bundle. The type provides the extension point; discipline provides correctness.

**Documentation mitigation**: README shows the canonical pattern (compose every attachment's readiness signal into `Promise.all`) and calls out the hazard.

### Bundle exposes a custom `whenReady` unrelated to actual readiness

`whenReady: someUnrelatedFetch()` would type-check but be semantically wrong. This is a foot-gun, but no worse than any other optional convention. Documentation covers it.

### Consumer reads resolved value of `whenReady`

TS types the resolved value as `unknown`. Consumer has to narrow before using. The type nudges consumers toward the correct "await for side effect, discard value" pattern.

## Open Questions

1. **Should `whenReady` be named differently?**
   - Candidates: `whenReady`, `ready`, `whenSettled`, `whenInitialized`.
   - **Recommendation**: keep `whenReady`. Matches the `when<X>` naming already used across the framework (`whenLoaded`, `whenConnected`, `whenChecked`, `whenDisposed`, `whenFlushed`). Consistent vocabulary.

2. **Should the framework provide any helper at all (e.g., `composeReadiness`)?**
   - Pro: reduces `Promise.all([...])` typing; one named helper vs one standard API call.
   - Con: adds a framework concept authors have to learn and reach for. `Promise.all` is literally already in every JS author's muscle memory.
   - **Recommendation**: no. The one-line change in this spec is the whole proposition. Don't pad it.

3. **Should the CLI's `whenReady` check use optional chaining or a guard?**
   - `await entry.handle.whenReady` — cleaner; resolves to `undefined` if absent (no-op).
   - `if (entry.handle.whenReady) await entry.handle.whenReady` — explicit.
   - **Recommendation**: the cleaner form. Awaiting `undefined` is fine.

4. **Document other bundles that need CLI use?**
   - In this repo today, only `playground/opensidian-e2e` exposes `whenReady`. No immediate need. Leave as author's call when new CLI-facing bundles land.

## Success Criteria

- [ ] `DocumentBundle` declares `readonly whenReady?: Promise<unknown>`.
- [ ] `packages/cli/src/commands/run.ts` TS diagnostics clean.
- [ ] `packages/cli/src/commands/run.ts:163` redundant `sync.whenConnected` await deleted.
- [ ] `playground/opensidian-e2e/epicenter.config.ts` composes `whenReady` with native `Promise.all([...])` (no `.then(() => undefined)` tail).
- [ ] README / skills document the pattern with a concrete example.
- [ ] `bun test` passes.
- [ ] `bun run build` passes.

## References

- `packages/workspace/src/document/create-document-factory.ts` — `DocumentBundle` and `DocumentHandle` types live here (or near; verify in Phase 1).
- `packages/workspace/src/document/attach-sync.ts:718-723` — `sync.rpc` internal self-gating on `waitFor` (why the CLI's `await sync.whenConnected` is redundant).
- `packages/cli/src/commands/run.ts:87,163` — the two CLI awaits addressed in Phase 2.
- `playground/opensidian-e2e/epicenter.config.ts` — the bundle that composes `whenReady` today; Phase 3 cosmetic cleanup.
- `packages/workspace/src/y-keyvalue-lww-encrypted.ts:199-247,324-387` — passthrough-and-reencrypt behavior; context for why pre-unlock writes don't need gating.
- [Yjs `Y.Doc.transact` and `Y.applyUpdate` semantics](https://deepwiki.com/yjs/yjs) — CRDT merge guarantees; context for why pre-hydration writes don't need gating.
- Earlier drafts of this spec (git history) — explored self-gating methods, framework-level readiness collectors, async factories, `*Now` variants, and `batch(fn)` primitives. All rejected in favor of this minimal change after walking through attachment construction (all sync) and Yjs/encryption semantics (already safe pre-ready).
