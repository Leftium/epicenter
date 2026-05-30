# MIT `@epicenter/identity` Package: Single-Source the Capability Vocabulary

Product sentence:
  Local capability state (`ownerId`, `keyring`, `AuthState`) lives once, in an MIT package below the license firewall, so the AGPL auth layer and the MIT workspace toolkit share one definition instead of hand-copying it across a boundary they are forbidden to cross.

## Why

Two problems share one root cause.

1. `packages/workspace/src/workspace-apps/auth-client.ts` hand-copies the auth state machine as `WorkspaceAuthState` (an 11-line discriminated union identical to `@epicenter/auth`'s `AuthState`). The copy exists because of a hard constraint, not a stylistic one:

```txt
MIT toolkit:  workspace, ui, filesystem, sync, util, encryption
AGPL tier:    auth, constants, svelte-utils, apps
```

`workspace` (MIT) importing `auth` (AGPL) would make the MIT toolkit non-distributable as MIT (AGPL is viral, enforced by `scripts/check-license-graph.ts`). So workspace cannot reach `AuthState` in auth, and copies it instead.

2. The copy is consistent with the `auth-opaque-client-boundary` spec (`specs/20260528T211151-...`): apps and workspace receive **capability state** (`ownerId`, `keyring`), not token semantics. `AuthState` is therefore capability data, not auth-credential behavior. It is built entirely from `OwnerId` (MIT `util`) and `Keyring` (MIT `encryption`), so it is fully expressible in MIT-land.

The fix is to give that capability vocabulary one MIT home below the firewall. Both tiers reach it legally; the copy is deleted; the boundary becomes a visible edge in the module graph rather than a comment.

This is not a correctness fix. Drift is already caught: every wiring site (`cli/up.ts`, every app `project.ts`) passes a real `SyncAuthClient` into a `WorkspaceAuthClient` slot, so an incompatible `AuthState` change fails to compile today. The win is architectural honesty and the deletion of a firewall workaround.

## End-state organization

```
  MIT TOOLKIT                                  AGPL TIER
  ──────────────────────────                   ──────────────────────
   util          encryption                    
  (debounce)    (crypto + Keyring)             
       │              │                        
       └──────┬───────┘                        
              ▼                                 
       @epicenter/identity  ◀── NEW, MIT        
       OwnerId, asOwnerId, TEAM_OWNER_ID,       
       AuthState                                
          │              │                      
   ┌──────┘              └──────────┐           
   ▼                                ▼           
  @epicenter/workspace   ░firewall░  @epicenter/auth (AGPL)
  (MIT) imports AuthState            AuthClient / SyncAuthClient
  declares its own narrow port       (behavior stays with impl)
```

Legal edges: `auth -> identity` and `workspace -> identity` both point down into MIT. `workspace -> auth` stays forbidden (`░`). The shared vocabulary sits below the firewall, reachable from both tiers.

Design rule honored: **data goes down, behavior stays.** `AuthState` (pure data) moves to MIT `identity`. `AuthClient`/`SyncAuthClient` (sign-in, sign-out, fetch, openWebSocket: behavior) stay in AGPL `auth`, co-located with their factories. Workspace keeps its explicit narrow port, now referencing the shared `AuthState`.

## What the new package contains

```ts
// packages/identity/src/identity.ts  (moved verbatim from packages/util/src/identity.ts)
import { type } from 'arktype';
import type { Brand } from 'wellcrafted/brand';
export const OwnerId = type('string').as<string & Brand<'OwnerId'>>();
export type OwnerId = typeof OwnerId.infer;
export const asOwnerId = (value: string): OwnerId => value as OwnerId;
export const TEAM_OWNER_ID = asOwnerId('team');
// ...plus the existing JSDoc, unchanged
```

```ts
// packages/identity/src/auth-state.ts  (moved from packages/auth/src/auth-contract.ts)
import type { Keyring } from '@epicenter/encryption';
import type { OwnerId } from './identity.js';

/**
 * Current auth state for local-first workspace clients.
 *
 * `ownerId` and `keyring` are present in `signed-in` and `reauth-required`
 * because they belong to local workspace operations: even when an OAuth grant
 * needs reauth, the cached owner id still picks the right local storage
 * partition and the keyring still decrypts local workspace data.
 *
 * This is capability state, not credential state. It lives in the MIT toolkit
 * so the MIT workspace and the AGPL auth client can share one definition
 * without workspace importing auth across the license firewall.
 */
export type AuthState =
  | { status: 'signed-out' }
  | { status: 'signed-in'; ownerId: OwnerId; keyring: Keyring }
  | { status: 'reauth-required'; ownerId: OwnerId; keyring: Keyring };
```

```ts
// packages/identity/src/index.ts
export * from './identity.js';
export * from './auth-state.js';
```

```jsonc
// packages/identity/package.json
{
  "name": "@epicenter/identity",
  "license": "MIT",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "@epicenter/encryption": "workspace:*",
    "arktype": "catalog:",
    "wellcrafted": "catalog:"
  },
  "devDependencies": { "typescript": "catalog:" },
  "scripts": { "typecheck": "tsc --noEmit" }
}
```

Copy `tsconfig.json` from `packages/util` (same compiler settings). The guard (`check-license-graph.ts`) auto-validates: identity is MIT and depends only on MIT packages, so no allowlist edit is needed.

## Source edits

### `@epicenter/auth` (AGPL)
- `auth-contract.ts`: delete the local `AuthState` definition; `import type { AuthState } from '@epicenter/identity'`. Keep `AuthClient`, `SyncAuthClient`, `AuthFetch` here. Re-export `AuthState` from the auth index if app consumers currently import it from `@epicenter/auth` (preserve their import path; verify with grep).
- All `OwnerId` imports: `@epicenter/util` -> `@epicenter/identity`.

### `@epicenter/workspace` (MIT)
- `workspace-apps/auth-client.ts`: delete `WorkspaceAuthState`. Point the port at the shared union:

```ts
// before: a hand-copied WorkspaceAuthState + WorkspaceAuthClient.state: WorkspaceAuthState
// after:
import type { AuthState } from '@epicenter/identity';
import type { OwnerId } from '@epicenter/identity';

export type WorkspaceAuthClient = {
  state: AuthState;                                              // shared, cannot drift
  openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
  onStateChange(fn: (state: AuthState) => void): () => void;
};
```

Keep `WorkspaceAuthClient` as an explicit local interface. Do NOT single-source it via `Pick<SyncAuthClient, ...>` (that would re-introduce the `workspace -> auth` firewall violation) and do NOT move it into identity (it carries a network-transport signature; identity is pure data). The three-method port stays explicit and readable; the union is what gets shared.

- All other `OwnerId` imports: `@epicenter/util` -> `@epicenter/identity`.

### `@epicenter/util` (MIT)
- Delete `src/identity.ts` (moved to identity). Update `src/index.ts` to `export { debounce } from './debounce.js';` only.

### The 36 import-redirect sites
Every file importing `OwnerId` / `asOwnerId` / `TEAM_OWNER_ID` from `@epicenter/util` re-points to `@epicenter/identity`. Verified: no file imports both `debounce` and an identity symbol from util, so each is a clean path replace on the import line. Packages affected: `client, sync, cli, svelte-utils, constants, server, auth, workspace`.

Discover the live set at execution time (do not trust this list blindly):
```bash
rg -rl "OwnerId|asOwnerId|TEAM_OWNER_ID" packages/ apps/ -g '*.ts' -g '*.svelte' \
  | while read f; do grep -q "@epicenter/util" "$f" && grep -Eq "OwnerId|asOwnerId|TEAM_OWNER_ID" "$f" && echo "$f"; done
```

### package.json wiring (per consumer package)
For each of the 8 affected packages: add `"@epicenter/identity": "workspace:*"` to `dependencies`. Remove `"@epicenter/util"` ONLY if that package no longer imports `debounce` (grep first). Then run `bun install` to relink the workspace graph.

### Licensing prose
`docs/licensing/licensing-strategy.md`: add `@epicenter/identity` to the MIT toolkit list (alongside util, encryption) with a one-line note: "capability/identity vocabulary shared by the MIT toolkit and the AGPL auth layer."

## Decision fork (the executing agent must respect the chosen variant)

- **Variant A (DEFAULT, endorsed): identity owns `OwnerId` + `AuthState`.** util returns to pure helpers. Cost: ~36 import-redirect files, which re-points `OwnerId` a second time (it moved `constants -> util` days ago; this moves `util -> identity`). This is the cohesive end state and is cheapest to do now while few files have hardened on the util path. This spec is written for Variant A.
- **Variant B (lower-churn fallback): identity owns `AuthState` only; `OwnerId` stays in `@epicenter/util`.** identity imports `OwnerId` from util. Touches ~5 files (auth, workspace, svelte-utils that reference `AuthState`), avoids the 36-file re-point. Cost: identity vocabulary is split across two packages (`OwnerId` in util, `AuthState` in identity), a mild discoverability smell. Choose this only if the `OwnerId` re-move churn is judged not worth the cohesion.

## Non-goals (clean break, no half-measures)
- No backward-compat re-export shims from `@epicenter/util` for the moved identity symbols. Update call sites; delete the old path.
- Do not single-source the client interface (`WorkspaceAuthClient` stays an explicit local port).
- Do not add a `satisfies` conformance assertion; the wiring call sites already enforce assignability.

## Verification (all must pass)
```bash
bun install
bun run --cwd packages/identity typecheck
bun run --cwd packages/util typecheck
bun run --cwd packages/auth typecheck
bun run --cwd packages/workspace typecheck
bun run --cwd packages/server typecheck
bun run --cwd packages/svelte-utils typecheck
bun run --cwd packages/cli typecheck
bun test packages/auth packages/workspace/src/workspace-apps packages/svelte-utils
bun run check:licenses     # must report identity among MIT packages, none reaching AGPL
```
Expectation: green typecheck across all touched packages, `WorkspaceAuthState` gone, `@epicenter/util` reduced to `debounce`, the license-graph guard listing `@epicenter/identity` as MIT.

## Commit shape (logical groups, conventional, no AI attribution)
1. `feat(identity): add MIT @epicenter/identity package with OwnerId + AuthState` (new package + move identity.ts + add auth-state.ts)
2. `refactor(auth): source AuthState from @epicenter/identity` (auth edits + its OwnerId redirects)
3. `refactor(workspace): delete WorkspaceAuthState, share AuthState from identity` (workspace edits + redirects)
4. `refactor: redirect OwnerId imports from util to identity` (the remaining server/cli/sync/client/svelte-utils/constants sites + package.json wiring)
5. `refactor(util): reduce @epicenter/util to debounce` (drop identity.ts)
6. `docs(licensing): list @epicenter/identity in the MIT toolkit`

Stage specific files per commit (never `git add -A`). Typecheck before the workspace/auth commits land; the util reduction (step 5) lands last because everything depended on the old path.
