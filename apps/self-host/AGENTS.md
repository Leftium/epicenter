# apps/self-host

Reference single-partition **instance** (ADR-0073): one operator-supplied bearer (`INSTANCE_TOKEN`), one pinned `owners/instance` partition. Composes `@epicenter/server` with `instance()` + `createInstanceTokenResolver(verifyEnvToken(token))`. Two runtimes off one composition: an off-Cloudflare Bun entry (`server.ts`, blessed) and a Cloudflare Worker (`worker/index.ts`); they run identically because the operator supplies the secret. "Solo" vs "shared" is only how many people hold the token, never a mode.

Not operated by Epicenter; framed as a community-supported starting point. Keep the worker entry small (~30 lines) so it stays readable as a reference.

Multi-tenancy (per-user partitions, OAuth, billing) is Epicenter Cloud's only (`apps/api`); an instance never grows a mode, an allowlist, OAuth, sessions, first-boot minting, Better Auth, or a database. The relational-auth substrate (Better Auth + Postgres) is Cloud-only (ADR-0074): the instance composes neither, so it provisions nothing but the token. Named per-person tokens are a deliberately-unbuilt seam (a hashed registry behind the same verifier + the same constant partition); build it only on real offboarding pain, never speculatively.

## Hard constraints

- Do not import `@epicenter/billing` (it no longer exists; billing lives inside `apps/api/worker/billing/` and is hosted-only).
- Do not add `autumn-js`, `AUTUMN_SECRET_KEY`, or `/api/billing/*` routes.
- Do not add a dashboard SPA or Workers Static Assets binding.
- Do not add OAuth, sessions, an allowlist, a launch-time mode selector, or first-boot token minting back: the instance is bearer-only by design (ADR-0073).
- Do not re-add Better Auth, Postgres, a `pg` pool, `DATABASE_URL`, `BETTER_AUTH_SECRET`, or a Hyperdrive binding: the relational-auth substrate is Cloud-only (`mountCloudAuth`), and the instance composes neither (ADR-0074). It uses `requireBearerUser` (never `requireCookieOrBearerUser`) and passes no rooms telemetry recorder.
- Do not collapse `INSTANCE_OWNER_ID` into env config: it is byte-pinned durable data (R2 prefix, DO name prefix, IDB prefix). The partition is pinned to the constant, decoupled from caller identity, so named tokens never re-partition.

## When editing

- Changes to composition primitives (`mount*`, `mountCloudAuth`, `personal()`, `instance()`) live in `packages/server`, not here.
- Updates to the deployment trust model live in `docs/trust-model.md` and `apps/api/README.md`.
- For deployment configuration, treat the wrangler bindings as user-customized; do not commit a working set of bindings.
