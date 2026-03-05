# Hono Factory Pattern Gives You Type-Safe Middleware and Handlers

Define your environment types once, create a factory from them, then use the factory to build every middleware and handler. All your code gets full type inference from that single type definition. No manual `Context<AppEnv>` annotations needed.

```typescript
// 1. Define your environment types in one place
export type Bindings = {
  DATABASE_URL: string;
  BETTER_AUTH_SECRET: string;
};

export type Variables = {
  auth: ReturnType<typeof createAuth>;
  user: { id: string; name: string; email: string };
};

export type AppEnv = { Bindings: Bindings; Variables: Variables };

// 2. Create a factory from that type
export const factory = createFactory<AppEnv>();

// 3. Every middleware and handler uses the factory
const authService = factory.createMiddleware(async (c, next) => {
  c.set('auth', createAuth(c.env));  // ✅ c.env is typed, c.set validates keys
  return next();
});

// 4. Handlers get the same typing for free
export function createProxyHandler() {
  return factory.createHandlers(async (c) => {
    const apiKey = c.env.OPENAI_API_KEY;  // ✅ typed as string | undefined
    const user = c.var.user;              // ✅ typed as { id, name, email }
    return c.json({ ok: true });
  });
}
```

Compare this to the manual approach. Without the factory, each file imports `Context` and `AppEnv` separately, annotating handlers individually.

```typescript
// Without factory: lots of boilerplate
import type { Context } from 'hono';
import type { AppEnv } from '../worker';

export function createProxyHandler() {
  return async (c: Context<AppEnv>) => {
    const apiKey = c.env.OPENAI_API_KEY;
    return c.json({ ok: true });
  };
}
```

The factory approach wins on three fronts. First, you avoid repeating the same type annotation across dozens of handler files. Second, types propagate automatically from the factory—change `AppEnv` and every handler sees the update. Third, reading `factory.createMiddleware()` immediately signals to readers that this code is part of the typed ecosystem.

```
AppEnv (single source of truth)
  │
  ├─> factory.createApp() ─────────> app.use(), app.get(), etc.
  │
  ├─> factory.createMiddleware() ──> authService, corsMiddleware, etc.
  │
  └─> factory.createHandlers() ────> createProxyHandler(), createChatHandler(), etc.

All four branches inherit the same Bindings and Variables.
```

The factory pattern scales. As your app grows from 2 middleware to 12, the cost of maintaining types stays zero. New files just call `factory.createMiddleware()` and get full typing immediately. No per-file type imports. No manual assertions.

Think of the factory as a "type amplifier." You define types once. The factory broadcasts them everywhere.
