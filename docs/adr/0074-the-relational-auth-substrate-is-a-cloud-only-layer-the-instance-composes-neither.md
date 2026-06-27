# 0074. The relational-auth substrate (Better Auth + Postgres) is a Cloud-only layer; the instance composes neither

- **Status:** Accepted
- **Date:** 2026-06-27
- **Relates:** [ADR-0073](0073-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) (the instance is one pinned partition behind one operator bearer; this is its server-substrate consequence), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (the db handle is a per-concern injected seam; this makes that seam optional so a deployment can decline it)

## Context

ADR-0073 made the self-hosted instance one pinned `owners/instance` partition behind one operator bearer, with no OAuth and no sessions. The shared server library did not follow: `createServerApp` still constructed Better Auth (a Postgres-backed `c.var.auth`) on every request, and the rooms route still wrote a fire-and-forget upsert into the `durableObjectInstance` table. So the instance composed a full relational-auth substrate (Better Auth plus a Postgres pool plus `BETTER_AUTH_SECRET`) that none of its bearer-only request paths read. The `durableObjectInstance` table is write-only across the entire repo (zero SELECTs; billing reads Autumn balances, not this table), so once the instance stops the telemetry upsert and stops constructing Better Auth, it has zero Postgres consumers.

## Decision

The relational-auth substrate is a Cloud-only layer; the instance composes neither Better Auth nor Postgres.

1. **Better Auth moves out of the shared core into `mountCloudAuth`,** which the hosted cloud calls once after `createServerApp`. It installs the per-request `c.var.auth` instance and the `authApp` surface (sign-in, consent, OAuth metadata). `createServerApp` wires only the portable core (the auth origin and trust set, CORS, the cookie-CSRF gate, the rooms registry, and the injected `resolveUser`), and `resolveUser` is required: the OAuth bearer resolver reads `c.var.auth`, which only the cloud has.
2. **The db lifecycle middleware installs only when the runtime provides `connectDb`.** The `RuntimeAdapter` db legs (`connectDb` and `afterResponse`) are optional; `bun()` and `cloudflare()` omit them when no db handle or Hyperdrive binding is passed. `resolveRooms` is the one leg every deployment provides.
3. **Room telemetry is an injected recorder.** The `durableObjectInstance` upsert is a `RoomAccessRecorder` the cloud passes to `mountRoomsApp`; the instance passes none, so its rooms route reads neither `c.var.db` nor `c.var.afterResponseQueue`.

The instance therefore composes only the rooms registry and the bearer surfaces (session, rooms, inference). It runs identically on Bun and Cloudflare with no database.

## Consequences

- **The instance drops Postgres entirely:** no `pg.Pool`, no `DATABASE_URL`, no Hyperdrive binding, no `pg`/`@types/pg` dependency. `BETTER_AUTH_SECRET` becomes register-when-present in `ServerBindings` (the same precedent as the OAuth secrets, ADR-0071): the cloud re-requires it at boot (apps/api/server.ts) and carries it as a deploy-gated Worker secret, the instance never reads it.
- **The two Bun entries diverge honestly.** `startBunServer` is the hosted cloud's Bun bootstrap (it bakes `mountCloudAuth` and cookie-or-bearer sessions); the instance Bun entry composes its thin surface directly. Two products, two compositions, with no shared mode knob, which is the same "false unification" warning ADR-0066 and ADR-0073 carry.
- **The pure instance-token primitives move to `@epicenter/auth`** (`generateInstanceToken`, `assertStrongToken`): a token can be minted and validated without the server graph, which is what lets a future `epicenter gen-token` live in the CLI.
- **The cost, named honestly:** the `durableObjectInstance` table is now Cloud-only and still write-only (zero readers repo-wide). It is kept behind the recorder seam rather than deleted, so this change stays minimal and revertable; deleting the table repo-wide (and the account-delete hook that clears it) is a deferred follow-up, not blocked by anything here.

## Considered alternatives

- **Keep one `createServerApp` god-factory and give the instance a no-op `connectDb`.** Rejected: a stub `c.var.db` is a lie the type system would carry everywhere, and the instance would still construct Better Auth. Declining the leg entirely (optional `connectDb`, no db middleware) is honest.
- **Delete the write-only `durableObjectInstance` table repo-wide now.** Deferred, not rejected: it is a larger change touching the schema and the Better Auth account-delete hook, and folding it in would entangle two concerns. The injected recorder seam already removes the instance's only Postgres dependency; the table's deletion can land on its own.
