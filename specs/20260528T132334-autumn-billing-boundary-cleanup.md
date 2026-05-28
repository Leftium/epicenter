# Autumn billing boundary cleanup

Status: IMPLEMENTED 2026-05-28, then REVISED after an adversarial grill (fleet of agents + autumn-js ground-truth). See Section 10 for the revisions, which supersede specific earlier decisions. Verified after revision: `bun test apps/api/worker/billing` 15 pass; `apps/api` tsc clean; `apps/api/ui` svelte-check 0 errors.

## 1. One sentence

A billing-provider failure is one opaque, fail-closed `BillingError` the dashboard renders as a message; one Autumn adapter owns the SDK (client construction, error mapping, the `tryAutumn` wrapper); and the service hands out reservation objects so policies orchestrate lifecycle (`reserve`, run, `confirm`/`release`/`credit`) without ever touching a `lockId`, an action string, or an Autumn error internal.

The earlier draft of this spec kept `BillingError` carrying the provider's exact HTTP `statusCode` and Autumn's machine `code` so the dashboard "could branch on them." Section 4a (Asymmetric wins pass) shows no consumer does, and refusing that promise deletes the largest code family in the cleanup, so the design below refuses it.

## 2. Current state

Four files share the Autumn boundary today, and the ownership is smeared across all four.

### 2a. `service.ts` doubles as the SDK error translator

```ts
// apps/api/worker/billing/service.ts
import { Autumn, AutumnError } from 'autumn-js';

export function toBillingError(error: unknown) {
  if (error instanceof AutumnError) {
    let code: string | undefined;
    let message: string = error.body;
    try {
      const parsed = JSON.parse(error.body) as unknown;   // <-- provider body parsing
      // ...pull code/message off the JSON...
    } catch { /* non-JSON body */ }
    return BillingError.ProviderRequestFailed({ statusCode: error.statusCode, code, message });
  }
  return BillingError.ProviderRequestFailed({ statusCode: 503, code: undefined, message: extractErrorMessage(error) });
}
```

`toBillingError` is exported from `service.ts` and imported by `routes.ts`. It is really an Autumn-SDK translator (it knows `AutumnError`, parses the raw provider body), but it lives in the domain-service file. The client construction (`new Autumn({ failOpen: false })`) is also inline in `createBillingService`.

### 2b. Policies cast an untrusted provider status straight to `ContentfulStatusCode`

```ts
// apps/api/worker/billing/policies.ts
function aiGuardStatus(error: AiChatError | BillingError): ContentfulStatusCode {
  if (error.name === 'ProviderRequestFailed') {
    return error.statusCode as ContentfulStatusCode;   // <-- untrusted provider value, blind cast
  }
  return AiChatErrorStatus[error.name];
}
```

`routes.ts` has the same blind cast in its `onError`:

```ts
return c.json(envelope, envelope.error.statusCode as ContentfulStatusCode);
```

`error.statusCode` is whatever Autumn sent (or 503 from the fallback). If a provider ever returns a non-content status (or a synthetic code), the cast lies to Hono.

### 2c. Loose `lockId` + action strings threaded through the policy

```ts
// service.ts  -- two separate functions, paired only by convention
async function guardAiChat(input: { model; provider; lockId: string }): Promise<Result<{ credits }, ...>>
function finalizeAiCharge(lockId: string, action: 'confirm' | 'release'): Promise<unknown>

// policies.ts  -- policy mints the lockId, then must re-pair it with the right action
const lockId = crypto.randomUUID();
const { error } = await billing.guardAiChat({ model, provider, lockId });
// ...
const action = c.res.status >= 400 ? 'release' : 'confirm';
c.var.afterResponse.push(billing.finalizeAiCharge(lockId, action));   // raw promise, swallowed
```

The policy owns the `lockId`, owns the action decision, and re-pairs them by hand. Nothing stops a future edit from passing the wrong `lockId` or inverting the action.

### 2d. Post-response settlement is fire-and-forget into a swallowing queue

`afterResponse` is drained with `Promise.allSettled` inside `waitUntil`:

```ts
// packages/server/src/server-app.ts
c.executionCtx.waitUntil(
  Promise.allSettled(afterResponse).then(() => client.end()),
);
```

`Promise.allSettled` never rejects, so a `finalize`/`track` rejection after a 2xx response is **invisible**: no log, no retry, no metric. `finalizeAiCharge`, `finalizeAssetStorage`, and `creditAssetStorage` all return raw promises pushed bare onto this queue.

## 3. Grounding against the Autumn SDK

Verified against the installed `autumn-js@1.2.5` types at `node_modules/.bun/autumn-js@1.2.5+.../dist/sdk/index.d.ts`, plus DeepWiki on `useautumn/autumn` for `failOpen` semantics.

```ts
// CheckLock  (index.d.ts:2142)
type CheckLock = {
  lockId: string;
  enabled: true;
  expiresAt?: number | undefined;   // unix ms; auto-releases the hold
};

// FinalizeBalanceParams  (index.d.ts:6100) -- balances.finalize(request)
type FinalizeBalanceParams = {
  lockId: string;
  action: 'confirm' | 'release';    // Action is a ClosedEnum
  overrideValue?: number | undefined;
  properties?: { [k: string]: any } | undefined;
};
type FinalizeLockResponse = { success: boolean };   // balances.finalize resolves to this

// AutumnError  (index.d.ts:1156) -- "base class for all HTTP error responses"
declare class AutumnError extends Error {
  readonly statusCode: number;
  readonly body: string;          // raw HTTP body text, NOT parsed JSON
  readonly headers: Headers;
  readonly contentType: string;
  readonly rawResponse: Response;
}

// Autumn client  (index.d.ts:16696) -- `class Autumn extends ClientSDK`
//   check(request: CheckParams): Promise<CheckResponse>          // CheckResponse.allowed: boolean
//   track(request: TrackParams): Promise<TrackResponse>
//   get balances(): Balances                                     // balances.finalize(FinalizeBalanceParams)
//   get customers(): Customers                                   // customers.getOrCreate(...)

// SDKOptions  (index.d.ts:80)
type SDKOptions = { secretKey?; failOpen?: boolean | undefined; /* ... */ };
```

### `failOpen` semantics (the load-bearing fact)

`failOpen` defaults to **`true`** and applies ONLY to `check`, `track`, `getOrCreateCustomer`, `getEntity`. When enabled, a network error or a **>= 500** response is rewritten into a safe dummy (`check` returns `allowed: true`). When set to **`false`** the `FailOpenHook` is disabled entirely:

- `check` / `getOrCreate` then **throw** on any non-2xx (including 5xx). 4xx (402 insufficient, 404 customer_not_found) throw regardless of `failOpen`.
- Network/connection failures surface as an `HTTPClientError` (e.g. `ConnectionError`), **not** an `AutumnError`. There is no 555 synthetic when the hook is disabled.
- `balances.finalize` and `billing.attach` are **never** in the fail-open set, so they throw on any non-2xx regardless of the flag.

Consequences for the design:

| Fact | Design consequence |
|---|---|
| `failOpen: false` is what makes the guard fail closed | Centralize `new Autumn({ failOpen: false })` in the adapter so the invariant lives in one place. |
| Network failures throw a non-`AutumnError` | `mapAutumnError` must keep a total fallback branch (-> 503), not assume `AutumnError`. |
| `AutumnError.body` is raw text | Body JSON parsing is an SDK-boundary concern, belongs in the adapter, never in routes/policies. |
| `finalize` always throws on non-2xx | Post-response settlement must `tryAutumn`-wrap and inspect the Result, never push a raw rejecting promise. |

## 4a. Asymmetric wins pass

```txt
Product sentence:
  A billing-provider failure is one opaque, fail-closed error the dashboard
  shows as a message. The meaningful billing states (out of credits, needs paid
  plan, storage exceeded) are typed domain variants on the AI/asset surfaces,
  not on BillingError. BillingError means only "the call to our billing provider
  failed."

Candidate refusal:
  BillingError carries the provider's exact HTTP statusCode and Autumn's machine
  `code` so the dashboard "can branch on error.statusCode === 402 or error.code".

Code family it deletes:
  - providerStatusToHttpStatus + the entire untrusted-cast problem (concern #2
    disappears by elimination, not by adding a validator)
  - mapAutumnError's provider-body JSON.parse + { code, message } extraction
  - BillingError payload: { statusCode, code, message } -> { message }
  - BillingErrorEnvelope: drops statusCode + optional code validation
  - ~4 translation tests (JSON body code-extraction, non-JSON body, JSON-drops-
    undefined-code, invalid-status-clamp)
  - api.ts readResponse statusCode/code reconstruction
  - aiGuardStatus / storageGuardStatus statusCode reads (-> constant 503)

User loss:
  The dashboard could SOMEDAY branch on error.code === 'customer_not_found' or
  error.statusCode === 402. Verified by grep: zero consumers do this today.
  Every consumer (UserMenu.svelte, +page.svelte, queries.ts) renders billing
  errors through toastOnError / extractErrorMessage as one opaque message. The
  meaningful 402/403 signals already live on AiChatError.InsufficientCredits,
  AiChatError.ModelRequiresPaidPlan, and AssetError.StorageLimitExceeded with
  their own status maps. errors.ts itself states it "deliberately avoids leaking
  the vendor name into the wire format" -- propagating Autumn's code/status
  contradicts that goal.

Decision:
  REFUSE it. The product sentence survives intact, the largest code family in
  the cleanup disappears, and concern #2 is solved by removing the untrusted
  value rather than validating it. Removing beats clamping.
```

Decisions NOT taken via asymmetric refusal (honest accounting): the **adapter** (decisions 1, 7) is an ownership *move*, not a refusal. **Reservation objects** (decision 4) are a correctness/ergonomics win that is roughly code-neutral (they add two closures and a type, remove `lockId` threading from policies); they are kept because they make the lock lifecycle impossible to mispair, not because they collapse a maintenance family. **Post-response logging** (decision 3) is the floor invariant ("never silently drop"), not a refusal. Only decision 2/6 is a true 10%-refuse / 90%-collapse win, and it is the one the first draft missed.

## 4b. Design decisions

| # | Concern | Decision | Why |
|---|---|---|---|
| 1 | Where does `toBillingError` live? | Move to a new `autumn.ts` adapter as `mapAutumnError`, now a one-liner (`extractErrorMessage`). | The SDK boundary owns "any provider throw -> `BillingError`". After the refusal there is no body parsing left to do. |
| 2 | `error.statusCode as ContentfulStatusCode` | **Eliminate the untrusted value.** `BillingError` no longer carries a provider status; `ProviderRequestFailed` always answers with a fixed **503** constant (our own choice: entitlement unverifiable -> service unavailable). No validator, no cast. | The cleanest fix for an untrusted-value cast is to not propagate the value. 503 is a trusted literal that `satisfies ContentfulStatusCode` with no cast. |
| 3 | Raw promises in `afterResponse` | Service finalize/credit return `Result<void, BillingError>`; policies schedule them through `scheduleBillingSettlement`, which logs the typed error (`error` for confirm/credit, `warn` for release; see Open Question 1). | A post-response billing failure is never silently dropped. The lock TTL already self-heals confirm/release; the credit refund does not, so it is the one that most needs the log. |
| 4 | Loose `lockId`/action pairing | Service returns reservation objects; `lockId` never leaves the service. | `reserve -> confirm()/release()` makes action pairing impossible to get wrong. (Ergonomics/correctness, not an asymmetric collapse.) |
| 5 | Copying SDK shapes | Do not copy. Construct `lock`/`finalize` args inline (SDK validates); keep the explicit Arktype schema only for the dashboard wire contract. | The wire contract is a real app contract; SDK request shapes are not. |
| 6 | `BillingErrorEnvelope` shape | **Shrink** to `{ data: null, error: { name, message } }`. Drop `statusCode` and `code`. | Validates exactly the refused contract: an opaque provider-failure message. Strict on our shape, tolerant of extra keys. |
| 7 | Client construction | Move `new Autumn({ failOpen: false })` into `createAutumnClient(env)` in the adapter. | The fail-closed invariant gets a single owner. |
| 8 | Route `onError` keeps its provider-vs-bug split | Adapter exports `isAutumnError(e): e is AutumnError`; `onError` rethrows non-Autumn (real 500) and translates Autumn -> 503 envelope. `routes.ts` stops importing `autumn-js`. | A programming bug in a dashboard read should be a 500, not a misleading "provider unreachable" 503. The guard exports keep `autumn-js` out of routes. |
| 9 | `withPreview: true` on the AI check (was Open Question 2) | Drop it. The guard only reads `allowed` / `balance`; the upsell payload is unused. | Smaller provider round-trip, one fewer unread field. Cheap win surfaced by the same pass. |

### Reservation object shape

```ts
// returned by the service, consumed by the policy
type AiReservation = {
  credits: number;
  confirm(): Promise<Result<void, BillingError>>;
  release(): Promise<Result<void, BillingError>>;
};
type AssetStorageReservation = {
  confirm(): Promise<Result<void, BillingError>>;
  release(): Promise<Result<void, BillingError>>;
};

reserveAiChat(input: { model: string; provider: string | undefined })
  : Promise<Result<AiReservation, AiChatError | BillingError>>;
reserveAssetStorage(input: { sizeBytes: number })
  : Promise<Result<AssetStorageReservation, AssetError | BillingError>>;

// delete refund has no prior hold to finalize, so it stays a standalone op
creditAssetStorage(sizeBytes: number): Promise<Result<void, BillingError>>;
```

The `lockId` is minted inside the service (via the adapter) and captured in the returned closure. The policy never sees it. `confirm`/`release` are the only two verbs, so `c.res.status` maps directly to a method call, not to an action string.

### Ownership table

```txt
Autumn client construction (failOpen:false)   adapter (createAutumnClient)
SDK error -> BillingError translation         adapter (mapAutumnError, one-liner)
provider-vs-bug discrimination                adapter (isAutumnError)
HTTP status for a provider failure            constant 503 (trusted literal, no cast)
lockId identity + finalize action pairing      service (reservation closure)
domain rules (unknown model, plan ceiling)    service (reserveAiChat / reserveAssetStorage)
reserve -> run -> settle orchestration        policy
post-response failure observability           policy (scheduleBillingSettlement) + logger
dashboard wire contract                       errors.ts (BillingErrorEnvelope, shrunk)
```

## 5. Target architecture

```txt
                         apps/api/worker/billing/

  routes.ts (dashboard reads)        policies.ts (mount middleware)
        |                                   |
        | onError:                          | reserve -> next() -> settle
        |   isAutumnError(err)              |
        |     ? c.json(mapAutumnError, 503) |   reserveAiChat / reserveAssetStorage
        |     : throw err  (-> 500)         v   -> Result<Reservation, ...>
        v
   +-----------------------------------------------------+
   |                     service.ts                      |
   |  domain ops: reserveAiChat, reserveAssetStorage,    |
   |  creditAssetStorage, getOverview, listPlans, ...    |
   |  returns Result<DTO | Reservation, BillingError>    |
   |  (no autumn-js import, no body parsing, no status)  |
   +-----------------------------------------------------+
                          |
                          | tryAutumn(() => autumn.check(...))
                          v
   +-----------------------------------------------------+
   |                     autumn.ts (ADAPTER)             |
   |  createAutumnClient(env) -> new Autumn(failOpen:false)
   |  mapAutumnError(unknown) -> BillingError  (one-line)|
   |  isAutumnError(e): e is AutumnError                 |
   |  tryAutumn(fn) -> Promise<Result<T, BillingError>>  |
   |  *** the ONLY file that imports autumn-js ***       |
   +-----------------------------------------------------+
                          |
                          v
                     autumn-js SDK

  AI reservation lifecycle:
    POST /api/ai/chat
      reserveAiChat() --ok--> AiReservation{ confirm, release }
            |                        |
        guard fail              await next()  (handler runs)
            |                        |
        c.json(err,            status >= 400 ? release() : confirm()
        503 / AiChatErrorStatus)
                                     |
                          scheduleBillingSettlement(c, op, level)
                                     |
                          afterResponse.push(op().then(logIfError))
```

## 6. Implementation checklist

Ordered build -> prove -> remove (clean break, no aliases left behind).

- [ ] **`errors.ts` (shrink the contract first)**:
  - [ ] `BillingError.ProviderRequestFailed` payload becomes `({ message }: { message: string }) => ({ message })`. Drop `statusCode` and `code`.
  - [ ] `BillingErrorEnvelope` becomes `type({ data: 'null', error: { name: "'ProviderRequestFailed'", message: 'string' } })`.
  - [ ] Update JSDoc: a `BillingError` is an opaque provider-failure message; the actionable billing states live on `AiChatError` / `AssetError`. Import the translator from `./autumn.js` in the example.
- [ ] **Create `apps/api/worker/billing/autumn.ts`** (the adapter):
  - [ ] `createAutumnClient(env: { AUTUMN_SECRET_KEY: string }): Autumn` returning `new Autumn({ secretKey, failOpen: false })`.
  - [ ] `mapAutumnError(error: unknown): BillingError` = `BillingError.ProviderRequestFailed({ message: extractErrorMessage(error) })`. One line: no `AutumnError` branch, no body parse.
  - [ ] `isAutumnError(error: unknown): error is AutumnError` = `error instanceof AutumnError`. The only place `autumn-js`'s `AutumnError` is referenced outside the SDK calls.
  - [ ] `tryAutumn<T>(fn: () => Promise<T>): Promise<Result<T, BillingError>>` = `tryAsync({ try: fn, catch: mapAutumnError })`.
  - [ ] Header comment: "the only file in billing that imports `autumn-js`."
- [ ] **Rework `service.ts`**:
  - [ ] Remove the `autumn-js` import and the inline `new Autumn(...)`; build the client via `createAutumnClient(env)`. Delete `toBillingError`.
  - [ ] Replace all inline `tryAsync({ ... catch: toBillingError })` with `tryAutumn(...)`.
  - [ ] Replace `guardAiChat` + `finalizeAiCharge` with `reserveAiChat(input): Promise<Result<AiReservation, AiChatError | BillingError>>`. Mint `lockId` internally; drop `withPreview`; on success return `{ credits, confirm, release }` where `confirm`/`release` call `tryAutumn(() => autumn.balances.finalize({ lockId, action }))`.
  - [ ] Replace `reserveAssetStorage` + `finalizeAssetStorage` with `reserveAssetStorage(input): Promise<Result<AssetStorageReservation, AssetError | BillingError>>`, same reservation-closure shape.
  - [ ] Change `creditAssetStorage(bytes)` to return `Promise<Result<void, BillingError>>` via `tryAutumn`.
  - [ ] Update the module header (the "nothing outside imports autumn-js" line moves to the adapter).
- [ ] **Rework `policies.ts`**:
  - [ ] Drop `crypto.randomUUID()` lock minting. `import type { ContentfulStatusCode }` stays only for the `AiChatErrorStatus` / `AssetError.status` lookups.
  - [ ] `aiGuardStatus` / `storageGuardStatus`: `ProviderRequestFailed -> 503` (a trusted literal; `503 satisfies ContentfulStatusCode`, no cast). All other variants map through their existing status source. No `as ContentfulStatusCode` anywhere.
  - [ ] Call `reserveAiChat` / `reserveAssetStorage`; on the Ok branch hold the reservation, `await next()`, then `scheduleBillingSettlement(c, level, () => status >= 400 ? reservation.release() : reservation.confirm())`.
  - [ ] DELETE path: `scheduleBillingSettlement(c, 'error', () => billing.creditAssetStorage(size))`.
  - [ ] Add the settlement helper + logger (see below).
- [ ] **Create `apps/api/worker/billing/settlement.ts`** (testable settlement seam):
  - [ ] `scheduleBillingSettlement(c, level: 'warn' | 'error', op: () => Promise<Result<void, BillingError>>, log: Logger = createLogger('billing')): void` pushes `op().then(({ error }) => { if (error) log[level](error); })` onto `c.var.afterResponse`. The optional `log` param is the DI seam tests use with a `memorySink`; production passes nothing.
- [ ] **Rework `routes.ts`**:
  - [ ] Import `isAutumnError`, `mapAutumnError` from `./autumn.js`. Stop importing `autumn-js`.
  - [ ] `onError`: `if (!isAutumnError(err)) throw err; return c.json(mapAutumnError(err), 503);` (503 is a trusted literal, no cast).
- [ ] **Tests**: see Section 7.

## 7. Verification checklist

Run focused first, then the package:

```bash
bun test apps/api/worker/billing/
bun --cwd apps/api run check    # or the repo's typecheck script for apps/api
```

### Reservation lifecycle (policies.test.ts, both AI and asset)

- [ ] success -> `confirm()` called exactly once, never `release()`.
- [ ] pre-handler guard rejection -> downstream handler NOT called, no reservation settled, structured envelope returned with the mapped status.
- [ ] downstream non-success (>= 400 for AI; != 201 for asset) -> `release()` called, never `confirm()`.
- [ ] DELETE 204 -> `creditAssetStorage(bytes)` scheduled; non-204 -> not scheduled.
- [ ] provider outage in `reserve*` -> fail closed: `Result.error` is a `BillingError` (`ProviderRequestFailed`), envelope shape on the wire.
- [ ] **confirm/credit failure is observed**: a rejected/`Err` settlement is logged (assert via injected `memorySink`, not `console`), per Open Question 1's chosen policy.
- [ ] release failure is logged at `warn` (self-healing), confirm/credit at `error`.

### Error translation (new `autumn.test.ts`)

After the refusal there is no provider-status / code branch to test. The whole surface is:

- [ ] `mapAutumnError(new AutumnError(...))` -> `ProviderRequestFailed` whose `message` = `extractErrorMessage` of the error.
- [ ] `mapAutumnError(new TypeError('network down'))` (non-`AutumnError`) -> `ProviderRequestFailed` with that message. (One total path; no JSON parse, no status.)
- [ ] `isAutumnError`: true for an `AutumnError` instance, false for a plain `Error`.

### Wire contract (errors.test.ts, updated for the shrunk shape)

- [ ] a serialized `BillingError` validates against the shrunk `BillingErrorEnvelope` (`{ name, message }`).
- [ ] the envelope rejects bodies missing `message` or with the wrong `name`.
- [ ] DELETE the old `statusCode` / `code` preservation tests and the "JSON drops undefined code" test (the fields are gone).

### Clean-break sweep

- [ ] `grep -rn "toBillingError\|guardAiChat\|finalizeAiCharge\|finalizeAssetStorage\|providerStatusToHttpStatus" apps/api/worker/billing` returns only historical specs, nothing live.
- [ ] `grep -rn "autumn-js" apps/api/worker/billing` returns only `autumn.ts`.
- [ ] `grep -rn "as ContentfulStatusCode" apps/api/worker/billing` returns nothing (the untrusted value is gone; 503 is a trusted literal).
- [ ] `grep -rn "statusCode\|\.code" apps/api/ui/src/lib/billing` shows `api.ts` no longer reconstructs those fields.

## 8. Open questions

### Open Question 1 (BLOCKING): durable retry vs structured logging for post-response failures

The three post-response operations fail differently:

```txt
confirm fails after a 2xx        lock is NOT committed -> auto-releases at TTL (15m)
                                 -> UNDERCHARGE (revenue leak), but self-heals
                                    toward the user. Severity: moderate.

release fails after a 4xx/5xx    lock auto-releases at TTL anyway.
                                 -> temporary over-hold only. Severity: low.

creditAssetStorage fails after   no lock to expire; it is a track({ value: -bytes }).
a successful DELETE              -> quota stays consumed after a successful delete.
                                    USER-UNFAVORABLE and PERMANENT (no self-heal).
                                    Severity: highest.
```

Durability priority is therefore **credit > confirm > release**.

Options:

- **A. Structured logging only (recommended for this spec).** Every settlement runs through `scheduleBillingSettlement`; failures are logged (`error` for confirm/credit, `warn` for release) and surface in Cloudflare tail / log drains. Makes the failure observable and alertable. Does NOT auto-recover the credit leak. No new infra. This is the invariant: *no post-response billing failure is silently dropped.*
- **B. Durable retry via Cloudflare Queue or a DO alarm.** Actually recovers the credit/confirm leak by re-attempting `finalize`/`track` with backoff and idempotency. Requires a queue binding (none exists in `apps/api` today) and an idempotency story for `track`/`finalize`. This is a product + infra decision, larger than this cleanup.

Recommendation: ship **A** now (it is the floor: stop dropping failures), and track **B** as a follow-up scoped to the credit path specifically, since that is the only permanent, user-unfavorable leak.

**Resolved 2026-05-28: Option A.** Structured logging for all three ops now (`error` for confirm/credit, `warn` for release), asserted in tests via an injected `memorySink`. Durable retry (Option B) is deferred to a separate follow-up scoped to `creditAssetStorage` only. Implementation may proceed.

### Open Question 2: RESOLVED -> `withPreview` dropped (now decision 9)

`reserveAiChat` only reads `allowed` / `balance`; the preview/upsell payload is unused, so the flag is dropped.

### Open Question 3 (non-blocking): should `reserveAiChat`'s plan-ceiling rule move to the catalog?

The free-tier `credits > FREE_TIER_MAX_CREDITS_PER_CALL` check is a domain rule currently inline in the service. Out of scope here, but flagging it so it is not mistaken for adapter logic.

## 9. Why opaque `BillingError` is the right UX (not laziness)

The refusal in 4a could read as "the dashboard treats billing errors as one opaque toast, so we kept it opaque." That would be paving a lazy cowpath. It is not the reasoning. The real reasoning is a taxonomy of *what the user can do*, not of HTTP status:

```txt
bucket            example                         right UX                         our type
----------------  ------------------------------  -------------------------------  --------------------------
actionable /      out of credits, model needs     inline upsell affordance w/      AiChatError.InsufficientCredits
conversion        paid plan, storage full          a primary CTA (Top up/Upgrade)   AiChatError.ModelRequiresPaidPlan
                                                   -- NEVER a toast                 AssetError.StorageLimitExceeded

transient /       billing provider down /         "Billing is temporarily          BillingError.ProviderRequestFailed
unverifiable      network blip                    unavailable, retry." inline for  (this spec)
                                                  reads, toast+retry for actions.
                                                  No useful sub-states.

our bug           invalid_plan, customer_not_     generic "something went wrong",  uncaught -> 500
                  found (we always getOrCreate)   logged, internals never shown
```

Key points:

1. The high-value billing UX (the conversion moments) is **bucket 1**, and those are already typed domain variants on the AI/asset surfaces with their own status maps (`AiChatErrorStatus`, `AssetError.status`). The refusal does not touch them. A `statusCode`/`code` on `BillingError` would never have driven that UX.
2. `BillingError` is **only bucket 2**: the provider call failed and we fail closed. Whether Autumn returned 502, 503, or a socket timeout, the user message is identical, and surfacing Autumn's `code` would leak vendor internals (which `errors.ts` explicitly avoids). So opaque-but-honest is the *correct* UX here, not a shortcut.
3. The genuine UX debt the grep exposed is **bucket 1 being under-consumed today**: `apps/*/.../chat-state.svelte.ts` currently `console.error`s a stream failure instead of branching on `chat.error.detail.name` to render an "out of credits -> Top up" CTA. The capability is fully built (`AiChatHttpError.detail`, the status maps); the UI just has not wired it. That is real and worth fixing, but it is a **separate UX workstream on the domain-error surfaces**, not a reason to add fields to `BillingError`. See Open Question 4.

### Open Question 4: RESOLVED -> separate spec, after this cleanup

Decided 2026-05-28: this spec stays server-boundary-only and ships first. The bucket-1 conversion UX gets its own spec (spec B), disjoint file set (`apps/api/ui` + the `chat-state.svelte.ts` consumers), so each reviews coherently. Spec B scope: a reusable upsell affordance (inline card or dialog, not a toast) triggered by `AiChatError.InsufficientCredits` / `ModelRequiresPaidPlan` / `AssetError.StorageLimitExceeded`; inline error+retry states for the dashboard read queries (`overview`/`plans`/`usage`) instead of silent `?.` empties; and wiring the chat clients to branch on `chat.error.detail.name` instead of `console.error`.

## 10. Post-grill revisions (2026-05-28)

After the first implementation, a fleet of agents + autumn-js@1.2.5 ground-truth
verification surfaced a real correctness bug and two design improvements. These
supersede the earlier decisions where they conflict.

### 10.1 BLOCKER fixed: the read path did not fail closed on a network error

Ground truth: `AutumnError` (HTTP non-2xx) and the `HTTPClientError` family
(`ConnectionError`, `RequestTimeoutError`, ...) are SIBLINGS; both are exported;
they share only the JS `Error` base. With `failOpen: false`, a network/transport
failure throws an `HTTPClientError`, NOT an `AutumnError`.

So the original `isAutumnError = error instanceof AutumnError` MISSED every
network failure. The guard path was fine (it wraps calls in `tryAutumn`, which
catches `unknown`), but the dashboard READS throw raw to `onError`, which only
caught `AutumnError`. Result: same provider outage answered 503 on the guard
path and 500 on the read path.

Fix: `isAutumnError` -> `isProviderError(error): error is AutumnError |
HTTPClientError` = `instanceof AutumnError || instanceof HTTPClientError`. A real
programming bug (`TypeError` in our mapping) still rethrows to a true 500.
Regression test added in `autumn.test.ts`. Supersedes decision 8.

### 10.2 Wire message is now a fixed opaque string; operator fidelity moves to logs

`mapAutumnError` previously set `message: extractErrorMessage(error)`, which
leaks the vendor's wording ("Autumn API error", "Unable to make request") to the
user, contradicting the opacity goal. And it discarded the rich detail (status,
body, class) that operators need.

Fix: `BillingError.ProviderRequestFailed` is now a zero-arg factory with a fixed
user-facing message. `mapAutumnError` LOGS the full original error first (4xx =
"Autumn rejected our request", likely our bug -> `error`; 5xx/network = transient
-> `warn`), then returns the opaque error. The adapter is the single chokepoint
where every provider failure is observed (it is called by `tryAutumn` on the
guard/reservation paths and by `onError` on the read path). Thin wire, fat log.
Supersedes decisions 1 and 6 (message handling).

### 10.3 settlement.ts deleted (collapsed into the adapter log)

Once `mapAutumnError` logs at the source, the `scheduleBillingSettlement` helper
was redundant: `confirm`/`release`/`credit` return a `Result` (never reject), a
failure is already logged by the adapter, and the policy just pushes the op onto
`afterResponse` to keep it alive for the request lifetime. Deleted
`settlement.ts` + `settlement.test.ts` and inlined the push. This drops the
per-op `warn`/`error` severity nuance, which the lock TTL self-heal (confirm/
release) and the reconciliation plan below (credit) make unnecessary. Supersedes
decision 3 and the settlement checklist items.

### 10.4 BillingError stays ONE opaque variant (fidelity question answered)

Considered: split into provider-down vs provider-rejected-our-request vs
our-bug. Decision: no. The user-actionable states (out of credits, needs paid
plan, storage full) already live on `AiChatError` / `AssetError`. The "is it
Autumn-internal vs our bug" distinction the operator wants is a LOGGING concern,
now served by 10.2's severity split, not a wire-contract concern. Adding wire
variants would re-bloat the contract for a distinction no client consumes.

Known limitation (accepted): the dashboard WRITE routes (`checkout`, `preview`,
`portal`) send a provider 4xx (e.g. `invalid_plan`) through `onError` as a 503
"temporarily unavailable." For this app, card entry happens on Stripe's hosted
page, so an attach 4xx is almost always our own bad request, now visible in logs
at `error` level (10.2). Richer typed checkout errors are deferred to spec B if
a real user-actionable attach failure surfaces.

### 10.5 Open Question 1 REVISED: durable retry is the wrong tool; reconciliation + native idempotency dominate

Decisive finding: Autumn's `track` natively accepts an `idempotencyKey` (dedupes
retries) AND negative values (credits balance back). And `waitUntil` is
explicitly NOT durable (Cloudflare docs: dropped work is "simply lost"). So the
credit-back leak is real, but a Cloudflare Queue / DO alarm is over-engineering:
both are at-least-once with no built-in dedupe (you write idempotency yourself),
both add infra (consumer worker / DO class + migration + paid plan), and both
still miss the "never enqueued" failure class.

Cheaper pattern that dominates on correctness-per-maintenance:
1. Pass a deterministic `idempotencyKey` to `track(-bytes)` and retry it inline.
2. Add a low-frequency reconciliation Cron Trigger that recomputes authoritative
   storage bytes per subject and corrects the Autumn balance. Storage total is
   recomputable by construction, so a missed credit self-heals on the next sweep,
   and this covers strictly more failure modes (dropped `waitUntil`, bugs that
   never enqueued) than any per-event retry.
3. log + alert as the floor (now provided by the adapter), not the mechanism.

This REPLACES the "durable retry follow-up." The follow-up spec (spec C) is
"idempotency key + storage reconciliation cron," not a queue. Sources: Stripe
error-handling/idempotent-requests docs, Cloudflare context/Queues/DO-alarms
docs, Autumn track reference, transactional-outbox + billing-reconciliation
writeups.
