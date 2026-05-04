# Collapse Machine Auth to Free Functions

**Date**: 2026-05-04
**Status**: Draft
**Author**: AI-assisted (Claude)
**Branch**: TBD (single PR; depends on `codex/sync-create-auth` landing)

## One-Sentence Test

The machine-auth Node module exports OAuth ceremony as free functions whose signatures declare exactly the errors they can return; `createMachineAuth`, `MachineAuthError`, `MachineAuthStorage`, and `MachineAuthStorageBackend` no longer exist.

If `createMachineAuth(...)` still returns an object with methods, the work is not done.
If any function declares an error variant it cannot produce, the work is not done.
If `console.*` still appears in the file, the work is not done.

## Overview

After `split browser and bearer factories` (commit `af5fea8e1`), the auth package's stateful clients live in `createBearerAuth`/`createBrowserAuth`. The stateless OAuth ceremony lives in `createMachineAuth`, which is a factory that holds no state. It only closes over its three injected dependencies and exposes four methods.

This spec converts that factory into top-level free functions. The `MachineAuthError` union dissolves by construction (no shared interface to declare it on). The `MachineAuthStorage` interface, the `MachineAuthStorageBackend` parallel type, and the `createKeychainMachineAuthStorage` factory collapse to two free functions: `loadMachineSession` and `saveMachineSession`. `console.warn` and `console.error` calls move to `wellcrafted/logger`.

`createMachineAuthClient` stays as a thin wiring helper. `createMachineAuthTransport` stays unchanged (it owns real state and OAuth response classification).

## Why this is its own spec

The thesis of `split browser and bearer factories` is *"two unlike credential lifecycles deserve two factories, not one factory with a discriminator."*

This spec's thesis is parallel but distinct: *"stateless orchestration deserves free functions, not a factory with a discriminator-shaped error union."* Different code surface, different motivating evidence (factory holds no state vs two factories sharing a base), different consumers. Per the cohesive-clean-breaks skill: when the work has its own sentence, it deserves its own spec.

The repo's prevailing pattern matches: see how `auth-client-sync-clean-break` and `auth-unified-client-two-factories` ship as separate specs even though they touch the same package.

## Motivation

### Current state

```ts
// packages/auth/src/node/machine-auth.ts

export const MachineAuthStorageError = defineErrors({
    StorageFailed: ({ cause }) => ({...}),
});  // one variant; just wraps cause

export type MachineAuthError =
    | MachineAuthTransportError
    | MachineAuthStorageError;

export type MachineAuthStorage = {  // interface
    load(): Promise<Result<BearerSessionType | null, MachineAuthStorageError>>;
    save(session): Promise<Result<undefined, MachineAuthStorageError>>;
};

export type MachineAuthStorageBackend = {  // parallel to typeof Bun.secrets
    get(options): Promise<string | null>;
    set(options, value): Promise<void>;
    delete(options): Promise<unknown>;
};

export function createKeychainMachineAuthStorage({  // factory wrapping backend
    backend = Bun.secrets,
}: { backend?: MachineAuthStorageBackend } = {}): MachineAuthStorage {...}

export function createMachineAuth({  // factory holds no state
    transport = createMachineAuthTransport(),
    storage  = createKeychainMachineAuthStorage(),
    sleep    = Bun.sleep,
} = {}) {
    return {
        async loginWithDeviceCode(...): Promise<Result<_, MachineAuthError>> {...},
        async status():               Promise<Result<_, MachineAuthError>> {...},
        async logout():               Promise<Result<_, MachineAuthError>> {...},
        async getEncryptionKeys():    Promise<Result<_, MachineAuthStorageError>> {...},
    };
}
```

### Problems

The `createMachineAuth` factory holds no state:
- No `let` at the factory scope.
- The closure exists purely to bundle `transport`, `storage`, and `sleep`.
- Compare to `createBearerAuth` in `create-auth.ts:88-170`, which holds `let session`, listener sets, and a dispose flag. That factory is justified. This one is not.

The `MachineAuthError` union over-types three of four methods:
| Method | Declared | Actual |
|---|---|---|
| `loginWithDeviceCode` | `MachineAuthError` | transport + storage (correct) |
| `status` | `MachineAuthError` | storage only: `machine-auth.ts:223-229` folds transport into `Ok({ status: 'unverified', verificationError })` |
| `logout` | `MachineAuthError` | storage only: `machine-auth.ts:244-249` swallows transport with `console.warn` |
| `getEncryptionKeys` | `MachineAuthStorageError` | storage only (already correct) |

`MachineAuthStorageBackend` is a parallel type for `typeof Bun.secrets`. It exists to permit DI in tests, but `typeof Bun.secrets` would do the same job.

`MachineAuthStorageError` defines one variant (`StorageFailed`) that only wraps the cause. The CLI never branches on the tag; it reads `.message`. The named alias does no work but is consistent with codebase typed-error discipline, so it stays.

The `console.warn`/`console.error` calls (`machine-auth.ts:110, 245-248, 283-285`) violate the codebase logger convention (`wellcrafted/logger` for library code per the `logging` skill).

### Desired state

```ts
// packages/auth/src/node/machine-session-store.ts (new)

export const MachineAuthStorageError = defineErrors({
    StorageFailed: ({ cause }) => ({...}),
});
export type MachineAuthStorageError = InferErrors<typeof MachineAuthStorageError>;

export async function loadMachineSession({
    backend = Bun.secrets,
}: { backend?: typeof Bun.secrets } = {}): Promise<Result<BearerSession | null, MachineAuthStorageError>>;

export async function saveMachineSession(
    session: BearerSession | null,
    { backend = Bun.secrets }: { backend?: typeof Bun.secrets } = {},
): Promise<Result<undefined, MachineAuthStorageError>>;
```

```ts
// packages/auth/src/node/machine-auth.ts (collapsed)

// MachineAuthError: gone
// MachineAuthStorage:        gone
// MachineAuthStorageBackend: gone
// createKeychainMachineAuthStorage: gone (replaced by loadMachineSession/saveMachineSession)
// createMachineAuth:         gone (replaced by free functions below)
// MachineAuth type alias:    gone

export async function loginWithDeviceCode({
    transport = createMachineAuthTransport(),
    sleep = Bun.sleep,
    backend = Bun.secrets,
    onDeviceCode,
}: {...} = {}): Promise<Result<MachineAuthLoginResult, MachineAuthTransportError | MachineAuthStorageError>>;

export async function status({
    transport = createMachineAuthTransport(),
    backend = Bun.secrets,
}: {...} = {}): Promise<Result<MachineAuthStatus, MachineAuthStorageError>>;

export async function logout({
    transport = createMachineAuthTransport(),
    backend = Bun.secrets,
}: {...} = {}): Promise<Result<MachineAuthLogoutResult, MachineAuthStorageError>>;

export async function getEncryptionKeys({
    backend = Bun.secrets,
}: {...} = {}): Promise<Result<EncryptionKeys | null, MachineAuthStorageError>>;

export async function createMachineAuthClient({
    backend = Bun.secrets,
}: {...} = {}): Promise<AuthClient> { ... }  // trimmed; uses loadMachineSession + saveMachineSession
```

Three things vanish (`MachineAuth`, `MachineAuthError`, `MachineAuthStorage*`). Each remaining function types its own actual error set. The Rust analogy holds: stateful client = factory; stateless ceremony = free functions taking deps.

## Design decisions

| Decision | Choice | Rationale |
|---|---|---|
| Coordinator shape | Free functions | Factory held no state. Free functions match what the code is. |
| Error union | Per-method types | Three of four methods were over-typed. Each function's signature is its contract. |
| Storage shape | Free functions in `machine-session-store.ts` | Storage interface added an interface and factory for ~10 lines of real logic (key naming, schema validation, corrupt-blob recovery). Free functions hold the same logic without ceremony. |
| Storage backend type | `typeof Bun.secrets` | The named `MachineAuthStorageBackend` was a parallel type for the same shape. Drop. |
| Storage error type | Keep `MachineAuthStorageError` as one-variant `defineErrors` | Consistent with codebase typed-error discipline. The variant name documents the failure mode even if the CLI doesn't branch on it. |
| Storage error handling | Result + bubble (not throw) | Matches codebase convention. CLI reads `.message` at the boundary. |
| Logger | `wellcrafted/logger` | Per `logging` skill: no `console.*` in library code. |
| Transport namespace | Unchanged | `MachineAuthTransport` factory closes over `fetch` (real DI state) and owns OAuth response classification. Justified. |
| Transport per-method narrowing | Out of scope | `MachineAuthTransportError` over-typing three of four transport methods is a separate, smaller question. Defer. |
| `createMachineAuthClient` | Keep as helper | 10-line wiring between two real abstractions. Inlining would scatter the wiring across 8+ consumers. |
| `DeviceCodeExpired` from coordinator | Stay in `MachineAuthTransportError` | Variant name still reads naturally even though the coordinator constructs it on timeout. Renaming is bikeshedding. |
| Public API | `node.ts` exports change | Drop `MachineAuthError`, `MachineAuth`, `MachineAuthStorage`, `MachineAuthStorageBackend`, `createKeychainMachineAuthStorage`. Add `loginWithDeviceCode`, `status`, `logout`, `getEncryptionKeys`, `loadMachineSession`, `saveMachineSession`. |

## Surface map

### Consumers of `createMachineAuth().{login,logout,status,getEncryptionKeys}`

| Site | Method | Migration |
|---|---|---|
| `packages/cli/src/commands/auth.ts:36` | login | `await loginWithDeviceCode({ onDeviceCode })` |
| `packages/cli/src/commands/auth.ts:56` | logout | `await logout()` |
| `packages/cli/src/commands/auth.ts:76` | status | `await status()` |
| `apps/fuji/src/lib/fuji/script.ts:27` | getEncryptionKeys | `await getEncryptionKeys()` (drop the `createMachineAuth()` line) |
| `playground/tab-manager-e2e/epicenter.config.ts:44` | (already broken; calls `getActiveEncryptionKeys`) | not in scope |
| `playground/opensidian-e2e/epicenter.config.ts:61` | (already broken; calls `getActiveEncryptionKeys`) | not in scope |

### Consumers of `createMachineAuthClient()`

8 sites across `apps/{opensidian,honeycrisp,zhongwen,fuji}/src/lib/*/{script,daemon}.ts` and `examples/notes-cross-peer/notes.ts`. Signature gains an optional `{ backend? }` parameter; existing zero-arg calls continue to work.

### Public API churn (`packages/auth/src/node.ts`)

```diff
 export {
-    createKeychainMachineAuthStorage,
-    createMachineAuth,
     createMachineAuthClient,
-    type MachineAuth,
-    type MachineAuthError,
-    type MachineAuthStorage,
-    type MachineAuthStorageBackend,
     type MachineAuthStorageError,
+    loginWithDeviceCode,
+    status,
+    logout,
+    getEncryptionKeys,
+    loadMachineSession,
+    saveMachineSession,
 } from './node/machine-auth.js';
+export {
+    type MachineAuthStorageError,
+} from './node/machine-session-store.js';
 export type {
     DeviceCodeResponse,
     DevicePollOutcome,
     MachineAuthTransport,
     MachineAuthTransportError,
 } from './node/machine-auth-transport.js';
```

## Implementation plan

Single PR. Waves are sequential but small.

### Wave 1: extract storage to free functions

- [ ] **1.1** Create `packages/auth/src/node/machine-session-store.ts`. Move `MachineAuthStorageError` definition, the keychain key, the schema validation, and the corrupt-blob recovery into two free functions: `loadMachineSession({ backend })` and `saveMachineSession(session, { backend })`. Both return `Result`. Both default `backend` to `Bun.secrets`.
- [ ] **1.2** The corrupt-blob warning uses `wellcrafted/logger` (not `console.warn`).
- [ ] **1.3** Delete `MachineAuthStorage`, `MachineAuthStorageBackend`, `createKeychainMachineAuthStorage` from `machine-auth.ts`. Move `MachineAuthStorageError` definition with the move (re-export from `machine-auth.ts` if simpler for downstream imports).

### Wave 2: collapse coordinator to free functions

- [ ] **2.1** In `machine-auth.ts`, rewrite `createMachineAuth` body's four methods as four exported free functions: `loginWithDeviceCode`, `status`, `logout`, `getEncryptionKeys`. Each takes `{ transport?, sleep?, backend?, onDeviceCode? }` (only the params it uses).
- [ ] **2.2** Replace `storage.load()`/`storage.save()` calls with `loadMachineSession({ backend })` / `saveMachineSession(session, { backend })`.
- [ ] **2.3** Delete `createMachineAuth`, `MachineAuth` (`ReturnType<typeof createMachineAuth>` alias), and `MachineAuthError` union.
- [ ] **2.4** Each function's signature declares its actual error set:
  - `loginWithDeviceCode`: `MachineAuthTransportError | MachineAuthStorageError`
  - `status`: `MachineAuthStorageError`
  - `logout`: `MachineAuthStorageError`
  - `getEncryptionKeys`: `MachineAuthStorageError`
- [ ] **2.5** The `signOutError` and `saveSession` warnings use `wellcrafted/logger`.

### Wave 3: update `createMachineAuthClient`

- [ ] **3.1** Trim `createMachineAuthClient` to use `loadMachineSession` and `saveMachineSession` directly. Add optional `{ backend }` parameter (defaults to `Bun.secrets`).
- [ ] **3.2** The `saveSession` callback's failure log uses `wellcrafted/logger`.

### Wave 4: update tests

- [ ] **4.1** `packages/auth/src/node/machine-auth.test.ts`: drop `makeMemoryStorage` (no longer needed) and `MachineAuthStorage`/`MachineAuthStorageBackend` imports. Use only `makeMemoryKeychainBackend` for storage in all tests.
- [ ] **4.2** Replace `createTestMachineAuth(fetch)` factory with direct calls: `await loginWithDeviceCode({ transport, backend, sleep })`, etc.
- [ ] **4.3** `keychain machine session storage` describe block now tests `loadMachineSession`/`saveMachineSession` directly.

### Wave 5: update consumers

- [ ] **5.1** `packages/cli/src/commands/auth.ts` x3 handlers: replace `const machineAuth = createMachineAuth(); await machineAuth.X()` with direct `await X()` calls.
- [ ] **5.2** `apps/fuji/src/lib/fuji/script.ts:26-31`: replace with direct `await getEncryptionKeys()` call.
- [ ] **5.3** `createMachineAuthClient` consumers: no signature change for default usage; spec adds `{ backend }` opt-in for advanced cases.

### Wave 6: public exports

- [ ] **6.1** Update `packages/auth/src/node.ts` per the diff above.
- [ ] **6.2** `packages/cli/README.md` examples updated (line 340-341 import block).

### Wave 7: verification

- [ ] **7.1** `bun run --filter @epicenter/auth typecheck` passes.
- [ ] **7.2** `bun run --filter @epicenter/auth test` passes.
- [ ] **7.3** `bun run --filter @epicenter/cli typecheck` passes.
- [ ] **7.4** `bun run --filter fuji typecheck` passes.
- [ ] **7.5** Workspace-wide `bun run typecheck` passes (every consumer migrated).
- [ ] **7.6** `epicenter auth login` / `status` / `logout` smoke test against staging API.

## Acceptance criteria

- [ ] `MachineAuthError` does not exist in the codebase.
- [ ] `MachineAuthStorage` and `MachineAuthStorageBackend` do not exist in the codebase.
- [ ] `createMachineAuth` does not exist in the codebase.
- [ ] `createKeychainMachineAuthStorage` does not exist in the codebase.
- [ ] `MachineAuth` type alias does not exist.
- [ ] No `console.warn`, `console.error`, or `console.log` in `machine-auth.ts` or `machine-session-store.ts`.
- [ ] `loginWithDeviceCode` signature: `Result<MachineAuthLoginResult, MachineAuthTransportError | MachineAuthStorageError>`.
- [ ] `status`, `logout`, `getEncryptionKeys` signatures: `Result<_, MachineAuthStorageError>`.
- [ ] `loadMachineSession`, `saveMachineSession` exist as free functions in `machine-session-store.ts`.
- [ ] All 5 consumer files migrated.
- [ ] Workspace-wide typecheck passes.

## Open questions

1. **Where does `MachineAuthStorageError` live after the split?** Two reasonable choices: (a) define it in `machine-session-store.ts` and re-export from `machine-auth.ts`; (b) keep its definition in `machine-auth.ts` and import from `machine-session-store.ts`. (a) is more cohesive (the error is owned by the file that produces it). Going with (a).

2. **Should `getEncryptionKeys` even exist?** Its body is `const session = await loadMachineSession(...); return session?.encryptionKeys ?? null;`. Three lines. The single external caller (`apps/fuji`) could inline. But the function name documents intent better than the inline three-liner. Keep.

3. **Should we narrow `MachineAuthTransportError` per-method via `Extract<>`?** Worth doing in a follow-up spec but explicitly out of scope here. The spec's thesis is the coordinator collapse; mixing transport refinements would dilute it.

4. **Should `createMachineAuthClient` also flatten?** It's a real wiring helper between two abstractions (storage + bearer auth). Inlining at 8 consumers would scatter the wiring. Keep.

5. **Logger sink in tests?** `wellcrafted/logger` requires DI. CLI commands provide a default sink at the entry point. Tests need an injected sink (probably a no-op or capturing collector). Implementation detail; note for review.

## Out of scope

- Narrowing `MachineAuthTransportError` per-method (separate spec).
- The playground configs that already reference removed methods (`getActiveEncryptionKeys`, `createMachineTokenGetter`); they're stale from a prior spec and need their own cleanup.
- Any in-memory cache between `createMachineAuth*` callers and `createMachineAuthClient` instances; CLI/daemon staleness is a known concern handled elsewhere.

## References

- `packages/auth/src/node/machine-auth.ts` (current implementation)
- `packages/auth/src/node/machine-auth-transport.ts` (transport, unchanged)
- `packages/auth/src/create-auth.ts:88-170` (stateful factory for contrast)
- `specs/20260503T230000-auth-unified-client-two-factories.md` (the split that established the precedent)
- Skills referenced: `cohesive-clean-breaks`, `logging`, `factory-function-composition`, `define-errors`, `error-handling`, `one-sentence-test`
