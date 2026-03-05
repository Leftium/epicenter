# Use c.var Instead of c.get in Hono

Stop writing `c.get('auth')` and access context variables directly via `c.var.auth`. The getter syntax loses type information and requires runtime string keys. Direct property access is typesafe and self-documenting.

```typescript
// Before: c.get() loses type information
const auth = c.get('auth');  // returns unknown, requires manual assertion

// After: c.var gives you full type inference
const auth = c.var.auth;  // typed as ReturnType<typeof createAuth>
```

When you define your context variables in `AppEnv`, Hono propagates that type information to every handler and middleware. Direct property access respects that typing. The string key approach doesn't.

```typescript
export type Variables = {
  auth: ReturnType<typeof createAuth>;
  user: { id: string; name: string; email: string };
  session: { id: string; token: string };
};

// In any handler or middleware:
const user = c.var.user;        // ✅ typed as { id, name, email }
const user = c.get('user');     // ❌ unknown, you have to assert
```

`c.get()` has a place: accessing values from middleware or plugins outside your control, where the key doesn't exist in your `Variables` definition. For your own context variables, `c.var` is cleaner, safer, and requires less boilerplate.

The shift is small but meaningful. Fewer type assertions. Better IDE autocomplete. Code that matches your type definitions.
