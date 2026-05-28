# Epicenter Self-Hosted Team (Reference)

Reference Cloudflare Worker for self-hosting Epicenter as a team. **Not operated by Epicenter.** Copy this folder, fill in the deployment-owned secrets and bindings, deploy, support yourself.

## What this is

`apps/team-api` is a ~30-line composition of `@epicenter/server` with the `team({ isMember })` ownership rule. Every authenticated user in the allowed-email list shares one workspace partition (`TEAM_OWNER_ID = "team"`).

## What this isn't

This is not Epicenter Cloud. There are:

- No Autumn billing routes
- No dashboard SPA
- No SLA, support contracts, or paid hosting from Epicenter

Community-supported. Issues filed against this folder are accepted as community contributions.

## Trust boundary

The deployer owns `ENCRYPTION_SECRETS`. Epicenter never sees it and therefore literally cannot decrypt workspace data hosted on your deployment. Self-hosted = functionally zero-knowledge against Epicenter.

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
  ENCRYPTION_SECRETS       "1:$(openssl rand -base64 32)"  (versioned)
  GOOGLE_CLIENT_SECRET     your Google OAuth client secret
  OPENAI_API_KEY           your provider key (or omit and BYOK)
  GEMINI_API_KEY           your provider key (or omit and BYOK)
```

## Deploy

```bash
bun run --cwd apps/team-api typegen      # generate worker-configuration.d.ts
bun run --cwd apps/team-api typecheck
bun run --cwd apps/team-api deploy
```

## Composition

The entire app is in `worker/index.ts`. Top to bottom:

```ts
const ownership = team({
  isMember: (c) => allowed.has(c.var.user.email),
});

createServerApp()
  .route('/', authApp)                                 // OAuth + sign-in pages
  // mountSessionApp(app, { ownership })              // GET /api/session
  // mountRoomsApp(app, { ownership })                // /api/owners/:ownerId/rooms/*
  // mountAssetsApp(app, { ownership })               // /api/owners/:ownerId/assets/*
  // mountAiApp(app, { auth: requireBearerUser });    // POST /api/ai/chat
```

Deliberately absent: `mountBillingApi`, `chargeAiCreditsWithAutumn`, `trackAssetStorageWithAutumn`, any `apps/api/ui` static-asset fallback. The composition shape is the contract.

## See also

- `specs/20260528T145510-deployment-collapse.md` for the design rationale
- `apps/api` for the hosted personal cloud variant (with billing + dashboard)
- `packages/server` for the shared library
