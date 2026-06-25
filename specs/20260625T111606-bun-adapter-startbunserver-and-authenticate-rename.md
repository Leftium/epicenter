# Bun runtime adapter + `startBunServer`, and `resolveUser → authenticate`

**Status:** In Progress

Two independent collapse moves surfaced by an asymmetric-wins pass over the
ADR-0059 runtime port (PR #2192). Both are backed by existing rules, not taste:
the `cloudflare()` extraction precedent, and the greenfield naming rule that
`resolve*` should mean pure validation/resolution.

Neither move changes behavior.

## Product sentences

- The same `@epicenter/server` app runs on two runtimes; `cloudflare()` and
  `bun()` are the only code that knows which, and only Bun has a process
  bootstrap (`startBunServer`).
- A request is `authenticate`d to a user; the verb names the security boundary.

---

## Move 1 — `bun()` adapter + `startBunServer`

### Why now

`packages/server/src/bun.ts` (and the inline adapter in both Bun entries)
argues *against* a `bun()` factory: "the Bun adapter has a single producer, so
it stays inline." PR #2192 added the second producer (`apps/self-host/server.ts`
beside `apps/api/server.ts`), so the rationale is now false and the exact
"two verbatim producers" condition that earned `cloudflare()` (`runtime/cloudflare.ts`)
now holds for Bun. The two entries' `startBunApiServer` / `startSelfHostServer`
functions are ~95% identical.

### Step 1: `bun()` runtime adapter

- New `packages/server/src/runtime/bun.ts`, the honest peer of `cloudflare()`:

  ```ts
  export function bun({ db, rooms }: { db: Db; rooms: Rooms }): RuntimeAdapter {
    return {
      connectDb: async () => ({ db, close: async () => {} }),
      afterResponse: () => {},
      resolveRooms: () => rooms,
    };
  }
  ```

  Honest asymmetry to document in the JSDoc: `cloudflare()` takes env
  *extractors* and builds db + rooms per request; a Bun process builds them
  once at boot, so `bun()` wraps the already-built instances. Same return type
  (`RuntimeAdapter`), different acquisition timing.

- Export `bun` from the main barrel (`index.ts`, beside `cloudflare`) and the
  `@epicenter/server/bun` barrel (`bun.ts`).
- Replace the byte-identical inline `runtime: { connectDb, afterResponse,
  resolveRooms }` triple in both entries with `runtime: bun({ db, rooms: bunRooms.rooms })`.
- Delete the stale "no `bun()` factory" comment in `bun.ts` and the matching
  comment in `apps/api/server.ts`.

### Step 2: `startBunServer` bootstrap

The two `start*Server` functions differ only in: ownership (`personal()` vs
`shared({ admit })` parsed from `ALLOWED_MEMBER_EMAILS`), trusted origins,
default port, health `mode` string, one extra mount (`mountBlobsApp` on api),
and the boot-log suffix. Everything else (env validation + exit, port/origin
derivation, `dataDir` + `createBunRooms`, `pg.Pool` + `createDb`, the `bun()`
adapter, `createServerApp`, the shared `authApp`/session/rooms/inference mounts,
`Bun.serve` + `bindServer` + log) is identical.

Design (no arktype generics — each entry validates its own env so it keeps a
precisely-typed env, then hands the validated value in):

- Export `BunHostBindings` from `@epicenter/server/bun` — `ServerBindings`
  merged with the shared Bun host config (`DATABASE_URL`, `PORT?`,
  `API_PUBLIC_ORIGIN?`, `DATA_DIR?`). Each entry validates with it (self-host
  merges `ALLOWED_MEMBER_EMAILS?`) and owns its own error label + exit.
- Export `startBunServer(opts)` taking the validated env plus the per-deployment
  composition:

  ```ts
  startBunServer({
    env,                    // validated, assignable to BunHostBindings.infer
    defaultPort,            // 8788 (api) | 8787 (self-host)
    mode,                   // 'hub' | 'shared'  (health response)
    ownership,              // personal() | shared({ admit })  (built from env by the caller)
    resolveTrustedOrigins,  // Identity['resolveTrustedOrigins']
    cookieDomain,           // optional
    mountExtras,            // optional (app, ownership) => void  (blobs on api)
    describe,               // optional ({ dataDir }) => string  (log suffix)
    resolveUser,            // dev entry injects; production omits
  })
  ```

  `startBunServer` derives port/origin/dataDir from `env`, builds pool + rooms +
  `bun()` adapter, calls `createServerApp({ runtime, identity, resolveUser })`,
  mounts `authApp` + session + rooms + inference, calls `mountExtras`, then
  `Bun.serve` + `bindServer` + boot log.

- Each entry keeps its thin `startBunApiServer({ resolveUser })` /
  `startSelfHostServer({ resolveUser })` wrapper (so `server.dev.ts` injection
  and `import.meta.main` are unchanged) and forwards into `startBunServer`.

### Acceptance (Move 1)

- Both entries shrink to env-validate + compose + one `startBunServer` call.
- Net ~100-150 fewer lines; the inline adapter triple and the false comments are gone.
- `bun.ts` no longer claims a single producer.
- Typecheck + existing tests + the runtime-parity smoke pass.

### Out of scope (confirmed load-bearing, do not touch)

The room seam, the blob store, and the `createServerApp` injection seams.

---

## Move 2 — `resolveUser → authenticate` (separate PR)

Pure rename. It authenticates (JWKS verify + DB lookup, a security boundary);
`resolve*` undersells that.

| Now | After |
|---|---|
| `resolveUser` (option + `c.var.resolveUser`) | `authenticate` |
| `resolveRequestOAuthUser` (prod default) | `authenticateOAuthBearer` |
| `resolveDevUser` (dev bypass) | `authenticateDevBearer` |
| type `ResolveUser` | `Authenticate` |

Leave `resolveOrigin`, `resolveTrustedOrigins`, `resolveRooms`,
`resolveOwnerPartition`, `resolveBlobStoreConfig` alone — they are pure/config/IoC
reads and the prefix carries real signal there.

Scope: ~24 call sites across `require-auth.ts`, `server-app.ts`, `types.ts`,
`dev-auth.ts` (both apps), `oauth-resource.ts`, `test-helpers/oauth.ts`, and
tests. Zero behavior change.

### Acceptance (Move 2)

- `grep -r 'resolveUser\|resolveRequestOAuthUser\|resolveDevUser'` returns nothing.
- Typecheck + full test suite pass.

---

## Branch / PR strategy

- **Move 1 lands on `feat/client-instance-setting` (PR #2192).** It is that
  branch's own debt: the duplicated entries and the lying comment exist because
  the branch created them. Merging without it ships the duplication.
- **Move 2 is a separate PR after #2192 merges, branched off updated main.**
  The rename touches `require-auth.ts`, `server-app.ts`, `types.ts`,
  `dev-auth.ts`, `oauth-resource.ts`, `test-helpers/oauth.ts` — every one of
  which PR #2192 also modifies, so a rename off main now collides. Doing it
  after merge keeps the rename a clean, isolated, conflict-free diff. (If it
  must happen sooner, stack it on the branch tip, not main.)

## Done = deleted

Delete this spec once Move 1 lands and Move 2's follow-up PR is open; record
Move 2 in its own PR body. Git keeps the body recoverable.
