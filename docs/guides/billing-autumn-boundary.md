# Billing and the Autumn boundary

A map of how cloud billing works in `apps/api/worker/billing/`, written so the
next person (or the next you) does not have to reverse-engineer it from four
files. If you are about to change anything in this folder, read this first.

## The one sentence

> Meter and gate paid usage (AI credits, storage bytes) against Autumn as the
> billing source of truth, while assuming Autumn can be slow, wrong, or down at
> any moment, so it must never over-charge, never hand out free usage during an
> outage, and never leak its internals to the user.

Every design choice below is a consequence of that second clause. If a piece of
code does not serve "treat the provider as fallible and untrusted," it is
probably ceremony. If it does, it earns its keep even when it looks like a smell.

## The layers

```
dashboard (apps/api/ui)            ui/src/lib/billing/api.ts   typed fetch client, Result<T, …>
        │  HTTP /api/billing/*
        ▼
routes.ts        HTTP shape: validate body, delegate, translate thrown errors
        │
        ▼
service.ts       one facade per request: every billing operation, returns DTOs
        │
        ▼
autumn.ts        the ONLY file that imports autumn-js. builds the client,
        │        wraps each round-trip, translates provider failures
        ▼
Autumn (external, fallible)
```

`policies.ts` sits to the side: it wraps the AI and asset routes (which live in
`@epicenter/server`) with the same `service.ts`, to reserve quota around work
the library does not know is billable.

## The thing that confuses everyone: two error paths

There are two ways a provider failure reaches the client, and they look
inconsistent until you see why.

```
DASHBOARD READS                        USAGE GUARDS
getOverview, listPlans, listUsage…     reserveAiChat, reserveAssetStorage
        │                                      │
 Autumn throws                          tryAutumn catches -> Result
        │                                      │
 routes.ts onError                      policy forwards error to c.json
        │                                      │
        ▼                                      ▼
   503 envelope                           4xx/503 envelope
```

Why the asymmetry: a guard cannot just throw, because it has already taken a
**reservation** and must settle it (release the hold) before responding. A read
has no reservation to clean up, so it lets the error throw to the single
`onError` boundary in `routes.ts`. The split is real work, not inconsistency.

## Reservations: reserve, then confirm or release

For anything billable that might fail (an AI call, an upload), we do not deduct
up front and refund on failure. We take a **lock** (a held balance), do the
work, then commit or roll back.

```
reserveAiChat ─► autumn.check({ requiredBalance: N,
                                lock: { lockId, expiresAt: now + 15min } })
                 │  N credits are HELD, not spent
                 ▼
             do the work (stream the model / write the upload)
                 │
        ┌────────┴─────────┐
   status < 400        status >= 400
        │                  │
   confirm()           release()
   finalize(confirm)   finalize(release)
   commit the charge   give the held credits back
```

`confirm` and `release` are the same one line (`finalizeLock(lockId, action)`)
with the action flipped. `confirm` commits the held balance, `release` returns
it.

### Why a lock and not Autumn's lighter `check({ sendEvent })`

Autumn's docs frame `lock`/`finalize` as the heavyweight primitive for
distributed holds, and steer you to `check({ sendEvent: true })` or
`check` + `track` for ordinary metering. We use the lock anyway for one reason:
the `expiresAt` TTL. On Cloudflare Workers an isolate can be evicted
mid-request. If we charged up front and the worker died before refunding, the
user would be over-charged forever. With a lock, a worker that dies between
reserve and settle simply lets the hold expire at the TTL: no charge, no manual
recovery. That crash-safety is what the lock buys. (We never pass
`override_value`, so we are not using the lock's variable-amount feature; the
TTL auto-release is the whole justification.)

## Errors: opaque on the wire, fat in the logs

A `BillingError` means exactly one thing: the call to Autumn failed, so we fail
closed. It is deliberately a single opaque message:

> "Billing is temporarily unavailable. Please try again."

It carries no HTTP status, no Autumn `code`, no provider wording. Whether Autumn
returned a 502, a 503, or a socket timeout, the only honest answer to the user
is the same, and surfacing the vendor's text would leak internals. The full
original error (status, body, class) is logged for operators at `mapAutumnError`
in `autumn.ts`. Thin wire, fat log.

The **actionable** states are NOT `BillingError`. "Out of credits" is
`AiChatError.InsufficientCredits({ balance })`, surfaced with the real number so
the dashboard can offer a top-up. "Model needs a paid plan" is
`AiChatError.ModelRequiresPaidPlan`. Those are typed domain variants with their
own statuses. So we surface specifics when the user can act, and silence when
they cannot (our provider broke). That is the right amount, not too much.

## Three things that look like smells and are not

If you come in with fresh eyes (good instinct), these will draw suspicion. Here
is why each survives:

1. **`error instanceof AutumnError || error instanceof HTTPClientError`**
   (`autumn.ts`, `isProviderError`). This is not branching on the difference
   between the two; it is membership in *either*. Autumn throws two unrelated
   class families: `AutumnError` (the service answered with a status) and
   `HTTPClientError` (the network never reached it: connection refused, timeout).
   Checking only `AutumnError` would let a real outage become a misleading 500
   instead of a fail-closed 503. The `||` is what makes "fail closed" closed.

2. **`confirm` vs `release`.** Not two code paths, one line with the action
   flipped. Minimal, not ceremony. (See the reservation diagram above.)

3. **The opaque message.** Intentional, not lazy. The informative errors have
   their own types; the opaque one is reserved for "the provider itself broke,"
   which is precisely the case that should leak nothing.

## The one genuine bit of ceremony

In `mapAutumnError`, the `instanceof AutumnError && statusCode < 500` branch
chooses `log.error` vs `log.warn`. Both arms return the identical
`BillingError`. The only difference is log severity (a 4xx from Autumn means we
sent a bad request and warrants attention; a 5xx or network failure is a
transient outage). It is defensible operational signal, but it is the only place
the two error tiers are treated differently, and the only branch you could
delete with zero behavior change.

## If you are changing this folder

- Adding a new billable operation: it goes through `service.ts`, which calls
  Autumn only via `autumn.ts`. Do not import `autumn-js` anywhere else.
- A new fallible-work guard: follow `reserveAiChat`: reserve a lock, return a
  reservation the policy settles around `next()`.
- A new dashboard read: let Autumn throw; `routes.ts` `onError` turns a provider
  failure into the opaque 503 and rethrows real bugs to a 500.
- Never widen the `BillingError` message to include provider text. That is the
  one invariant the whole error design protects.
