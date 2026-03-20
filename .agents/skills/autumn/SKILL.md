---
name: autumn
description: Integrate Autumn billing—define features/plans in autumn.config.ts, use autumn-js SDK for credit checks/tracking, manage the atmn CLI for push/pull. Use when working on billing, pricing, credits, plan gating, or metered usage.
metadata:
  author: epicenter
  version: '1.0'
---

# Autumn Billing Integration Guide

## Reference Repositories

- [Autumn](https://github.com/useautumn/autumn) — Usage-based billing platform
- [Autumn TypeScript SDK + CLI](https://github.com/useautumn/typescript) — `autumn-js` SDK and `atmn` CLI
- [Autumn Docs](https://docs.useautumn.com)

---

## When to Apply This Skill

Use this when you need to:

- Define or modify features, credit systems, or plans in `autumn.config.ts`.
- Add credit checks or usage tracking via the `autumn-js` SDK.
- Gate API endpoints behind billing (free tier limits, paid plan access).
- Push/pull billing config with the `atmn` CLI.
- Debug billing issues (insufficient credits, customer sync, refunds).

---

## Naming Conventions (CRITICAL)

**All IDs use `snake_case`.** This is Autumn's explicit convention.

```typescript
// CORRECT
feature({ id: 'ai_chat_fast', ... })
plan({ id: 'pro', ... })
plan({ id: 'credit_top_up', ... })

// WRONG — don't use kebab-case
feature({ id: 'ai-chat-fast', ... })
plan({ id: 'credit-top-up', ... })
```

---

## Feature Types

| Type | `consumable` | Use Case | Example |
|------|-------------|----------|---------|
| `metered` | `true` | Usage that resets periodically (messages, API calls) | AI chat messages |
| `metered` | `false` | Persistent allocation (seats, storage) | Team seats |
| `credit_system` | — | Pool that maps to metered features via `creditSchema` | AI credits |
| `boolean` | — | Feature flag on/off | Advanced analytics |

**Credit systems** require linked `metered` features with `consumable: true`. Each linked feature has a `creditCost` defining how many credits one unit consumes.

```typescript
export const aiCredits = feature({
  id: 'ai_credits',
  name: 'AI Credits',
  type: 'credit_system',
  creditSchema: [
    { meteredFeatureId: 'ai_chat_fast', creditCost: 1 },
    { meteredFeatureId: 'ai_chat_smart', creditCost: 3 },
    { meteredFeatureId: 'ai_chat_premium', creditCost: 10 },
  ],
});
```

---

## Plan Structure

### Groups

Plans in the same `group` are **mutually exclusive**. Subscribing to a new plan in the same group replaces the old one. Autumn handles the Stripe subscription swap automatically.

- **Upgrade** (free → pro): Immediate swap with proration.
- **Downgrade** (pro → free): Scheduled for end of billing cycle.

### Add-ons

Plans with `addOn: true` **stack** on top of any plan. No group conflict.

### `autoEnable`

Plans with `autoEnable: true` are auto-assigned when a customer is created via `customers.getOrCreate()`. Use for free tiers. Only allowed on plans with no `price`.

### Plan items: `reset` vs `price` (mutually exclusive)

A `PlanItem` can have `reset` OR `price`, never both:

- **`PlanItemWithReset`**: Included allowance that resets on an interval (e.g., 50 credits/month free). No pricing—just a free allocation.
- **`PlanItemWithPrice`**: Usage-based pricing with its own billing cycle. `price.interval` encodes the reset cadence. Use for overage billing.
- **`PlanItemNoReset`**: No reset, no price. For boolean features or continuous-use features.

```typescript
// Free plan — reset only, no price
item({ featureId: aiCredits.id, included: 50, reset: { interval: 'month' } })

// Paid plan — price encodes the billing cycle (no separate reset)
item({
  featureId: aiCredits.id,
  included: 2000,
  price: { amount: 1, billingUnits: 100, billingMethod: 'usage_based', interval: 'month' },
})
```

---

## SDK: `autumn-js`

### Initialization

```typescript
import { Autumn } from 'autumn-js';

const autumn = new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
```

Stateless—safe to create per-request. No connection pooling needed.

### Customer Sync (MUST be blocking)

```typescript
await autumn.customers.getOrCreate({
  customerId: userId,
  name: userName ?? undefined,
  email: userEmail ?? undefined,
});
```

**This call MUST be awaited (blocking).** Autumn's `/check` endpoint does not auto-create customers. The customer must exist before any `check()` call.

### Credit Check

```typescript
const { allowed, balance } = await autumn.check({
  customerId: userId,
  featureId: 'ai_chat_smart',  // The metered feature ID, not the credit system ID
  requiredBalance: 1,
  sendEvent: true,              // Atomically deduct on allow
  properties: { model, provider },
});

if (!allowed) {
  // Return 402 with balance info
}
```

**`featureId`** is the metered feature ID (e.g., `ai_chat_smart`), not the credit system ID. Autumn resolves the credit cost through the `creditSchema` mapping.

**`sendEvent: true`** atomically deducts credits when `allowed: true`. No separate `track()` call needed for the happy path.

### Refund on Error

```typescript
await autumn.track({
  customerId: userId,
  featureId: 'ai_chat_smart',
  value: -1,  // Negative value = refund
});
```

Use when the operation fails after credits were already deducted (e.g., AI stream errors). Typically pushed to an `afterResponse` queue to avoid blocking the error response.

---

## CLI: `atmn`

### Setup

```bash
bunx atmn login        # OAuth login, saves keys to .env
bunx atmn env          # Verify org and environment
```

### Config File

`autumn.config.ts` at the project root. Defines features and plans using `atmn` builders:

```typescript
import { feature, item, plan } from 'atmn';
```

### Push/Pull

```bash
bunx atmn preview      # Dry run — shows what would change
bunx atmn push         # Push to sandbox (interactive confirmation)
bunx atmn push --prod  # Push to production
bunx atmn push --yes   # Auto-confirm (for CI/CD)
bunx atmn pull         # Pull remote config, generate SDK types
```

### Data Inspection

```bash
bunx atmn customers    # Browse customers
bunx atmn plans        # Browse plans
bunx atmn features     # Browse features
bunx atmn events       # Browse usage events
```

---

## Environment & Secrets

| Key | Environment | Prefix |
|-----|-------------|--------|
| `AUTUMN_SECRET_KEY` | Sandbox (test) | `am_sk_test_...` |
| `AUTUMN_SECRET_KEY` | Production | `am_sk_prod_...` |

Use the **same key name** in both environments. Let your secrets manager (Infisical, etc.) swap the value per environment. Don't create separate key names for sandbox vs prod.

For Cloudflare Workers: `wrangler secret put AUTUMN_SECRET_KEY`

For local dev with Infisical: secrets are auto-injected via `infisical run --path=/api -- wrangler dev`

---

## Middleware Pattern (Cloudflare Workers + Hono)

### Ensure Customer Exists

Run after `authGuard`, before any billing-gated routes:

```typescript
app.use('/ai/*', async (c, next) => {
  const autumn = createAutumn(c.env);
  await autumn.customers.getOrCreate({
    customerId: c.var.user.id,
    name: c.var.user.name ?? undefined,
    email: c.var.user.email ?? undefined,
  });
  await next();
});
```

**Why inline?** Cloudflare Workers don't expose `env` at module scope. The Autumn client must be created inside the request handler.

### Credit Gate in Handler

```typescript
const modelClass = getModelClass(data.model);
if (!modelClass) return c.json(error, 400);

const { allowed, balance } = await autumn.check({
  customerId: c.var.user.id,
  featureId: modelClass,
  requiredBalance: 1,
  sendEvent: true,
});

if (!allowed) return c.json(error, 402);
```

---

## Stripe Integration

- **Sandbox**: Built-in Stripe test account. No setup needed.
- **Production**: Connect via Dashboard → Integrations → Stripe (OAuth recommended).
- Autumn creates Stripe products/prices automatically when you `atmn push`.
- Autumn is the source of truth for customer state; Stripe handles payments.

---

## Common Gotchas

1. **`getOrCreate` must be awaited** — Fire-and-forget will cause `check()` to fail with "customer not found."
2. **`featureId` in `check()` is the metered feature**, not the credit system. Autumn resolves credit cost via `creditSchema`.
3. **`reset` and `price` are mutually exclusive** on plan items. Use `price.interval` to encode billing cycle on paid items.
4. **`sendEvent: true` deducts atomically** — Don't call `track()` separately for the happy path. Only use `track({ value: -1 })` for refunds.
5. **Plan IDs are snake_case** — Autumn's pricing agent convention. Don't use kebab-case.
6. **`autoEnable` triggers on customer creation** — Not on first `check()`. Ensure the middleware calls `getOrCreate` before checking.
7. **Multiple keys per environment** — Autumn supports multiple active secret keys for rotation. Generate new key → update secrets → revoke old key.

---

## Project Files

| File | Purpose |
|------|---------|
| `apps/api/autumn.config.ts` | Feature, credit system, and plan definitions |
| `apps/api/src/autumn.ts` | `createAutumn(env)` factory for per-request SDK client |
| `apps/api/src/model-classes.ts` | Model string → credit class (feature ID) mapping |
| `apps/api/src/ai-chat.ts` | Credit check + refund logic for AI chat handler |
| `apps/api/src/app.ts` | Middleware wiring (ensureAutumnCustomer) |

---

## Resources

- [Autumn Docs](https://docs.useautumn.com)
- [Autumn Dashboard](https://app.useautumn.com)
- [GitHub: Autumn](https://github.com/useautumn/autumn)
- [GitHub: TypeScript SDK + CLI](https://github.com/useautumn/typescript)
- [API Keys](https://app.useautumn.com/dev?tab=api_keys)
