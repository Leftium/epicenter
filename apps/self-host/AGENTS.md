# apps/self-host

Reference Cloudflare Worker for self-hosting Epicenter as a shared wiki. Composes `@epicenter/server` with `shared({ admit })`.

Not operated by Epicenter; framed as a community-supported starting point. Keep the worker entry small (~30 lines) so it stays readable as a reference.

## Hard constraints

- Do not import `@epicenter/billing` (it no longer exists; billing lives inside `apps/api/worker/billing/` and is hosted-only).
- Do not add `autumn-js`, `AUTUMN_SECRET_KEY`, or `/api/billing/*` routes.
- Do not add a dashboard SPA or Workers Static Assets binding.
- Do not collapse `SHARED_OWNER_ID` into env config: it is byte-pinned durable data (HKDF label, R2 prefix, DO name prefix, IDB prefix).

## When editing

- Changes to composition primitives (`mount*`, `shared()`, `personal()`) live in `packages/server`, not here.
- Updates to the encryption trust model live in `docs/encryption.md` and `apps/api/README.md`.
- For deployment configuration, treat the wrangler bindings as user-customized; do not commit a working set of bindings.
