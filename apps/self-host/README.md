# Epicenter Self-Hosted Shared Wiki (Reference)

Reference Cloudflare Worker for self-hosting Epicenter as a shared wiki. **Not operated by Epicenter.** Copy this folder, fill in the deployment-owned secrets and bindings, deploy, support yourself.

## What this is

`apps/self-host` is a ~30-line composition of `@epicenter/server` with the `shared({ admit })` ownership rule. Every authenticated user in the allowed-email list shares one workspace partition (`SHARED_OWNER_ID = "shared"`).

## What this isn't

This is not Epicenter Cloud. There are:

- No Autumn billing routes
- No dashboard SPA
- No SLA, support contracts, or paid hosting from Epicenter

Community-supported. Issues filed against this folder are accepted as community contributions.

## Trust boundary

The deployer operates the infrastructure. Epicenter never holds or sees the data stored here, so self-hosting is functionally zero-knowledge against Epicenter.

## What to fill in

```txt
wrangler.jsonc
  ALLOWED_MEMBER_EMAILS    comma-separated allowed emails
  GOOGLE_CLIENT_ID         your Google OAuth client id (public)
  SESSION_KV.id            your KV namespace id
  HYPERDRIVE.id            your Hyperdrive id
  ASSETS_BUCKET.bucket_name your R2 bucket name

wrangler secret put ...
  BETTER_AUTH_SECRET       openssl rand -base64 32
  GOOGLE_CLIENT_SECRET     your Google OAuth client secret
  OPENAI_API_KEY           optional house key; omit and members BYOK
  GEMINI_API_KEY           optional house key; omit and members BYOK
```

## Deploy

```bash
bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host deploy
```

`worker-configuration.d.ts` is hand-written: it inherits the library's
binding contract (`ServerBindings`) and declares only deployment-owned
vars, so there is no typegen step. If you add bindings of your own, declare
them there (or regenerate with `bun run typegen` and re-add the `extends`
clause).

## Composition

The entire app is in `worker/index.ts`. Top to bottom:

```ts
const ownership = shared({
  admit: (c) => allowed.has(c.var.user.email),
});

createServerApp()
  .route('/', authApp)                                 // OAuth + sign-in pages
  // mountSessionApp(app, { ownership })              // GET /api/session
  // mountRoomsApp(app, { ownership })                // /api/owners/:ownerId/rooms/*
  // mountAssetsApp(app, { ownership })               // /api/owners/:ownerId/assets/*
  // mountAiApp(app, { auth: requireBearerUser, ownership }) // POST /api/ai/chat
```

Deliberately absent: `mountBillingApi`, `chargeAiCreditsWithAutumn`, `syncAssetStorageWithAutumn`, any `apps/api/ui` static-asset fallback. The composition shape is the contract.

## See also

- `specs/20260528T145510-deployment-collapse.md` for the design rationale
- `apps/api` for the hosted personal cloud variant (with billing + dashboard)
- `packages/server` for the shared library
