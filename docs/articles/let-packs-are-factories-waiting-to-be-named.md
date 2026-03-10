# Let Packs Are Factories Waiting to Be Named

Every factory function accumulates `let` statements over time. A retry counter here, a timer handle there, a timestamp that only makes sense alongside the timer. Each one looks harmless on its own. But when three `let` declarations always get read together, written together, and reset together, they aren't three variables. They're one concept missing a name.

## The tell: `let` statements that move in packs

Here's a WebSocket sync provider before any extraction. Look at the `let` declarations scattered across the closure:

```typescript
export function createSyncProvider(config: SyncProviderConfig): SyncProvider {
  let desired: 'online' | 'offline' = 'offline';
  let status: SyncStatus = 'offline';
  let runId = 0;
  let connectRun: Promise<void> | null = null;
  let websocket: WebSocketLike | null = null;
  let retries = 0;
  let reconnectSleeper: Sleeper | null = null;
  const statusListeners = new Set<(status: SyncStatus) => void>();

  // ... 400 lines of logic that manipulates all of these
}
```

Eight mutable bindings in the outer scope. Some are genuinely independent: `desired` tracks user intent, `websocket` tracks the current socket. But `retries` and `reconnectSleeper`? Those two are joined at the hip. Every place that reads `retries` also creates a `reconnectSleeper`, and every successful connection resets both:

```typescript
// This 5-line ceremony appeared TWICE in the supervisor loop:
const timeout = backoffDelay(retries);
retries += 1;
reconnectSleeper = createSleeper(timeout);
await reconnectSleeper.promise;
reconnectSleeper = null;
```

And somewhere else, a completely different function needed to interrupt it:

```typescript
function handleOnline() {
  reconnectSleeper?.wake();
}
```

Three variables (`retries`, `reconnectSleeper`, plus the `backoffDelay` helper) that only exist to serve one concept: "wait with exponential backoff, and let me interrupt it."

## The extraction: give the concept a name

Pull the coupled state into its own factory. The return type is the concept's API:

```typescript
function createBackoff() {
  let retries = 0;
  let sleeper: { promise: Promise<void>; wake(): void } | null = null;

  return {
    async sleep() {
      const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
      const ms = exponential * (0.5 + Math.random() * 0.5);
      retries += 1;

      const { promise, resolve } = Promise.withResolvers<void>();
      const handle = setTimeout(resolve, ms);
      sleeper = { promise, wake() { clearTimeout(handle); resolve(); } };
      await promise;
      sleeper = null;
    },

    wake() { sleeper?.wake(); },
    reset() { retries = 0; },
  };
}
```

The supervisor loop goes from five duplicated lines to one:

```typescript
await backoff.sleep();
```

And the online handler goes from reaching into closure internals to calling a named method:

```typescript
function handleOnline() {
  backoff.wake();
}
```

The outer function drops from 8 `let` bindings to 6, and the two that disappeared were the hardest to reason about because they interacted across multiple functions.

## How to spot more extraction candidates

The pattern repeats. After extracting backoff, the same sync provider still had this inside `attemptConnection`:

```typescript
let pingInterval: ReturnType<typeof setInterval> | null = null;
let livenessInterval: ReturnType<typeof setInterval> | null = null;
let lastMessageTime = Date.now();
```

These three get set together in `onopen`, cleared together in `onclose`, and `lastMessageTime` gets touched in `onmessage`. Same tell: always read together, always written together.

```typescript
function createLivenessMonitor(ws: WebSocketLike, WS: { readonly OPEN: number }) {
  let pingInterval: ReturnType<typeof setInterval> | null = null;
  let livenessInterval: ReturnType<typeof setInterval> | null = null;
  let lastMessageTime = 0;

  return {
    start() {
      lastMessageTime = Date.now();
      pingInterval = setInterval(() => {
        if (ws.readyState === WS.OPEN) ws.send('ping');
      }, PING_INTERVAL_MS);
      livenessInterval = setInterval(() => {
        if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) ws.close();
      }, LIVENESS_CHECK_INTERVAL_MS);
    },
    touch() { lastMessageTime = Date.now(); },
    stop() {
      if (pingInterval) clearInterval(pingInterval);
      if (livenessInterval) clearInterval(livenessInterval);
    },
  };
}
```

The event handlers go from managing timer handles to calling named lifecycle methods:

```typescript
ws.onopen = () => {
  // ... handshake logic ...
  liveness.start();
};

ws.onclose = () => {
  liveness.stop();
  // ... cleanup ...
};

ws.onmessage = (event) => {
  liveness.touch();
  // ... message handling ...
};
```

A third cluster was hiding in plain sight: `status`, `statusListeners`, and the `setStatus` function. Classic observable pattern with no name.

```typescript
function createStatusEmitter<T>(initial: T) {
  let current = initial;
  const listeners = new Set<(value: T) => void>();

  return {
    get() { return current; },
    set(value: T) {
      if (current === value) return;
      current = value;
      for (const listener of listeners) listener(value);
    },
    subscribe(listener: (value: T) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    clear() { listeners.clear(); },
  };
}
```

## The diagnostic questions

When you're staring at a factory function with too many `let` statements, ask:

| Question | If yes |
|---|---|
| Do these variables get set in the same function? | They might be one concept |
| Does resetting one require resetting the others? | They definitely are |
| Does an external caller need to reach into one of them? | The concept needs a public API |
| Would naming the group make the call sites read better? | Extract it |

Not every cluster should be extracted. `desired`, `runId`, and `connectRun` in the sync provider are all part of the supervisor's control flow. They're coupled to each other but also deeply woven into the loop's branching logic. Extracting them would create an abstraction that renames the complexity without reducing it. The test is whether the call sites get simpler, not whether you can draw a box around the variables.

## The result

The sync provider went from 8 mutable bindings and scattered timer/listener management to 4 `let` statements and 3 `const` factories:

```typescript
export function createSyncProvider(config: SyncProviderConfig): SyncProvider {
  let desired: 'online' | 'offline' = 'offline';
  let runId = 0;
  let connectRun: Promise<void> | null = null;
  let websocket: WebSocketLike | null = null;

  const status = createStatusEmitter<SyncStatus>('offline');
  const backoff = createBackoff();
  // createLivenessMonitor is scoped per-connection inside attemptConnection

  // ...
}
```

Each factory encapsulates 2-3 `let` variables and exposes 3-4 methods. The outer function reads like a sequence of named concepts instead of a tangle of raw state. And because each factory is a plain function at module scope, they're independently testable without wiring up the entire provider.
