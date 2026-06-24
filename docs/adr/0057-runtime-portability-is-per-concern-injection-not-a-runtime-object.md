# 0057. Server runtime portability is per-concern injection chosen by whether an open standard exists, not a Runtime object

- **Status:** Accepted
- **Date:** 2026-06-24
- **Relates:** the in-flight spec `specs/20260623T234500-one-server-runtime-port-vs-per-owner-instance.md` (the grill and wave plan this harvests), [ADR-0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) (the same config-not-code, deployment-chooses posture for inference backends), [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md) (why identity/secrets stay a shared plane, not per-instance)

## Context

`@epicenter/server` is one Hono library behind two Cloudflare deployables (`apps/api` personal, `apps/self-host` shared wiki). Two capabilities drove a portability push: the content-addressed blob store (a pure aws4fetch S3 client, no R2 binding) and the room relay (already behind the `Rooms`/`RoomUpdateLog`/`RoomSocket` contracts, with only a Cloudflare backend). Two tempting unifications appeared: a per-owner "instance" that hosts both capabilities, and a single `Runtime` god-object with co-equal `db`/`sessionStore`/`assets`/`rooms`/`afterResponse` legs handed to `createServerApp`. A first-principles grill rejected both. The instance is a deployment topology for a different product (hosting arbitrary per-owner code) and a false merge of two unlike lifecycles (a mutable single-writer live actor vs immutable owner-less bytes). The god-object overstates the work roughly fivefold by treating portable-standard concerns as if they were rooms, and it re-bundles exactly what the `mount*` and `resolveOrigin` design deliberately unbundled.

## Decision

Decide runtime portability per subsystem by one question: **is there an open standard both runtimes already speak?**

- **Road 1 (collapse to the standard).** If yes, depend on the standard and maintain no second backend. Object storage collapses to S3-over-HTTPS (blobs, done). SQL collapses to the Postgres wire via `pg`/drizzle (db: portable already; only connection *acquisition* differs). The Better Auth KV session cache is **deleted, not ported** (Postgres plus the JWE cookie cache is one path; this shipped).
- **Road 2 (inject a tiny per-concern contract).** If no, define the smallest Epicenter-owned contract and supply one backend per runtime, chosen at the `apps/*` edge. The only Road-2 subsystem is the room: a hibernating, single-writer, stateful actor has no open standard.

The seam is **per-concern injection** at the deployment edge (`resolveOrigin`, `connectDb`, `afterResponse`, `resolveRooms`), in the shape of the already-shipped `resolveOrigin`. There is **no single `Runtime` object**, and library code never reads `Cloudflare.Env` or imports `cloudflare:workers`. The Durable Object is the cloud's Road-2 binding of the room actor, **not the unit of deployment**; identity, billing, and the shared Postgres are a global plane, not per-instance state. A Bun/Node dev entry (`apps/api/server.ts` beside `worker/index.ts`, same Hono app) is the keystone second runtime that validates the seam; both entries are kept permanently.

## Consequences

- **Self-host can drop Cloudflare:** one binary plus a Postgres URL plus any S3 endpoint, no account required. The same Bun/Node entry is what a Tauri shell embeds locally.
- **The library reads zero Cloudflare bindings directly** once the waves land (`db`, `afterResponse`, `rooms`, `blobs` are injected per concern); only the deployment edge names a runtime. The `cloudflare:workers` mock leaves the room tests.
- **The cloud keeps per-room Durable Object sharding and hibernate-to-zero forever.** The collapse does not remove the DO; it makes the DO one binding. The per-room granularity and per-tenant scale-to-zero are exactly what multi-tenant cloud needs and what a single self-host process gets for free.
- **Two room backends must stay faithful to one `RoomCore`,** proven by running `RoomCore`'s tests against both. This is the standing maintenance cost Road 2 buys.
- **Dev-prod runtime skew is accepted and fenced:** a DO-only bug (hibernation, alarms, edge) will not surface in Bun dev, so `wrangler dev` / staging stays the fidelity gate before any deploy touching room behavior.
- **What this forecloses:** a single `Runtime` god-object (rejected as re-bundling), and the per-owner-instance product (a separate primitive that would still leave identity global). Refusing both is what keeps the seam explainable in one sentence.
</content>
