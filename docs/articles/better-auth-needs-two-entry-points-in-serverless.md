# Better Auth Needs Two Entry Points in Serverless

In serverless, there's no long-lived process. Your auth instance gets created on every request. That's fine — Better Auth is designed for it. You write a factory function that takes the request's environment and returns a fresh `betterAuth()` instance:

```ts
export function createAuth(env: AuthEnv) {
  return betterAuth({
    ...sharedAuthConfig,
    database: { type: 'postgres', url: env.DATABASE_URL },
    secret: env.BETTER_AUTH_SECRET,
    secondaryStorage: { /* KV bindings from env */ },
  });
}
```

But then you need to run the CLI — `bunx @better-auth/cli generate` or `migrate`. The CLI needs to import a file that exports a static `auth` object. It introspects the config to generate types and migrations. It can't call your factory function because it doesn't have Cloudflare bindings, KV namespaces, or any of the runtime context your factory expects.

So you need two entry points into the same auth config.

## The split

Extract everything that affects the database schema into a shared object:

```ts
export const sharedAuthConfig = {
  basePath: '/auth',
  emailAndPassword: { enabled: true },
  plugins: [bearer(), jwt(), oauthProvider({ /* ... */ })],
} satisfies Partial<BetterAuthOptions>;
```

Plugins, base path, feature flags — anything that changes what tables or columns exist. This is the source of truth.

Then two consumers spread it:

```
┌─────────────────────┐
│   sharedAuthConfig   │  ← plugins, basePath, feature flags
│  (schema-affecting)  │
└──────────┬───────────┘
           │ spreads into
     ┌─────┴─────┐
     │           │
┌────▼────┐  ┌───▼──────────────┐
│ auth.ts │  │ createAuth(env)  │
│  (CLI)  │  │ (Worker runtime) │
└─────────┘  └──────────────────┘
  static       per-request factory
  process.env  Cloudflare bindings
```

**`auth.ts`** — the CLI entry point. Reads `process.env`, validates with arktype, exports a static `auth` object. This is what `@better-auth/cli` imports.

**`createAuth(env)`** — the runtime factory. Takes Cloudflare bindings, adds session config, KV caching, trusted origins — everything the CLI doesn't need and can't provide.

Both spread `sharedAuthConfig`. If the schema-affecting options ever diverge between CLI and runtime, your migrations won't match your tables. One shared object makes that impossible.

## What goes where

| Option | `sharedAuthConfig` | `createAuth` | `auth.ts` |
|--------|-------------------|-------------|-----------|
| plugins | Yes | | |
| basePath | Yes | | |
| emailAndPassword | Yes | | |
| database URL | | Yes (from bindings) | Yes (from process.env) |
| secret | | Yes (from bindings) | Yes (from process.env) |
| session config | | Yes | |
| secondaryStorage (KV) | | Yes | |
| trustedOrigins | | Yes | |
| cookies / CORS | | Yes | |

The rule: if it changes the schema, it goes in `sharedAuthConfig`. If it's runtime behavior, it goes in `createAuth`. If it's just there so the CLI can boot, it goes in `auth.ts`.
