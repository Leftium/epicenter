# Action return shapes — local vs. remote contract

Actions have **two** type surfaces, not one. The same `defineQuery` /
`defineMutation` is typed differently depending on how it's invoked. This
reference explains what each caller sees, when to throw vs. return `Err`,
and how the wrapping happens at each boundary.

## The three call contexts

```
 1. LOCAL      workspace.actions.tabs.close({...})
                (same process, direct function call — zero wrapping)

 2. ADAPTER    epicenter run tabs.close            (CLI)
               LLM calls tabs_close tool           (AI bridge)
                (in-process, formatter peels the Result envelope)

 3. REMOTE     createRemoteActions(...).tabs.close({...})
               sync.rpc(peer, 'tabs.close', ...)
                (crosses the wire — always Result-wrapped)
```

## One handler, every caller's view

Given this handler:

```typescript
tabs.close: defineMutation({
  input: Type.Object({ tabIds: Type.Array(Type.Number()) }),
  handler: async ({ tabIds }) => {
    const { error } = await tryAsync({
      try: () => browser.tabs.remove(tabIds),
      catch: (cause) => TabError.BrowserApiFailed({
        operation: 'tabs.remove',
        cause,
      }),
    });
    if (error) return Err(error);
    return Ok({ closedCount: tabIds.length });
  },
})
```

| Caller                        | Ok path                          | Err(BrowserApiFailed)                            | Handler throws                                     |
| ----------------------------- | -------------------------------- | ------------------------------------------------ | -------------------------------------------------- |
| **Local** (in-process)        | `{data:{closedCount:1}, error:null}` | `{data:null, error:BrowserApiFailed}`        | throws at `await`                                  |
| **CLI** `epicenter run`       | prints `{"closedCount":1}`, exit 0 | stderr + exit 1                                | stderr stack trace + exit 1 (via yargs)            |
| **AI bridge** (TanStack AI)   | AI sees `{closedCount:1}`        | AI sees "tool call failed: …"                    | propagates — AI sees failure                       |
| **`createRemoteActions`**     | `Ok({closedCount:1})`            | `Err(BrowserApiFailed)` — typed, no re-wrap      | `Err(RpcError.ActionFailed{cause: <throw>})`       |
| **`sync.rpc()`** (peer RPC)   | `Ok({closedCount:1})`            | `Err(RpcError.ActionFailed{cause: BrowserApiFailed})` — **E erased** | `Err(RpcError.ActionFailed{cause: <throw>})` |

The `sync.rpc()` row's Err column is the only place the typed error is
coarsened — this is a property of that specific API (which is typed
`Result<T, RpcError>`), not of the handler design. For typed errors on
the wire, use `createRemoteActions`.

## Where the wrapping happens

On the wire path (remote), there are exactly **two normalization points**:

```
Server (handler-owner)                 Client (caller)
─────────────────────                  ───────────────
attach-sync.ts handleRpcRequest        remote-actions.ts makeLeaf
  raw value    → Ok(raw)                 got {data,error}? → passthrough
  Result       → passthrough             got raw value?    → Ok(raw)
  throw        → RpcError.ActionFailed   transport threw?  → RpcError.ActionFailed
```

Server-side normalization runs inside `attachSync`. The client-side
normalization lives in `createRemoteActions`. Both sides emit the same
nominal `RpcError.ActionFailed` — no nested `{cause: <nested action error>}`
re-wrapping.

The legacy `sync.rpc()` outbound method has an additional wrap on the client
(at `attach-sync.ts:816`) that converts any non-`RpcError` value in the
error channel to `RpcError.ActionFailed({cause})` — which is why its typed
surface is `Result<T, RpcError>` rather than `Result<T, E | ActionFailed>`.

## Decision tree for handler authors

```
Does failure need a specific UX on the caller side?
│
├── YES → return Result, name the error variant
│         (BrowserApiFailed, NotFound, ValidationFailed, …)
│         Callers pattern-match on error.name.
│
└── NO  → can it realistically fail?
          │
          ├── YES (network, filesystem, flaky external) → try/catch + throw,
          │        OR return Err(generic) if a caller might want to branch
          │
          └── NO (invariant, bug) → throw — no need to dress up a
                                    programmer error as a Result
```

**Rule of thumb:** return `Err` for things your caller should handle; throw
for bugs. Remote callers *always* see some discriminant in the error channel
— your typed `Err(X)` if you named the failure, or `ActionFailed` if you
threw. There's no "I don't handle errors" path once the call crosses the wire.

## Decision tree for callers

```
Am I calling locally or remotely?
│
├── LOCAL → does the handler return Result?
│           │
│           ├── YES → destructure {data, error}, switch on error.name
│           │
│           └── NO  → just use the value; try/catch if you want to handle
│                     throws
│
└── REMOTE → always destructure {data, error}
             ├── Ok path: use data
             └── Err path: switch on error.name
                  ·  your typed errors if the handler returned Err
                  ·  'ActionFailed' for throws and transport/server bugs
```

## Call-site examples

### Pattern 1 — Handler returns raw (can't meaningfully fail)

```typescript
// HANDLER
bookmarks.removeAll: defineMutation({
  handler: () => {
    const all = tables.bookmarks.getAllValid();
    batch(() => {
      for (const b of all) tables.bookmarks.delete(b.id);
    });
    return { removedCount: all.length };
  },
})

// LOCAL
const { removedCount } = workspace.actions.bookmarks.removeAll();

// REMOTE (createRemoteActions)
const { data, error } = await remote.bookmarks.removeAll();
if (error) toast.error('Operation failed');  // only transport/server bug
else toast.success(`Removed ${data.removedCount}`);
```

### Pattern 2 — Handler returns Result (typed failure is contract)

```typescript
// LOCAL
const { data, error } = await workspace.actions.tabs.close({ tabIds: [1] });
if (error) {
  // error.name === 'BrowserApiFailed' — known, typed
  toast.error(error.message);
  return;
}
toast.success(`Closed ${data.closedCount}`);

// REMOTE (createRemoteActions)
const { data, error } = await remote.tabs.close({ tabIds: [1] });
if (error) {
  switch (error.name) {
    case 'BrowserApiFailed': toast.error(error.message); break;
    case 'ActionFailed':     toast.error('Connection problem'); break;
  }
  return;
}
```

Call sites are structurally identical. Remote just widens the error union
by `ActionFailed`.

### Pattern 3 — Handler throws (bug-flavored, not part of contract)

```typescript
// HANDLER
devices.rename: defineMutation({
  input: Type.Object({ id: Type.String(), name: Type.String() }),
  handler: ({ id, name }) => {
    const existing = tables.devices.get(id);
    if (!existing) throw new Error(`Device ${id} not found`);
    tables.devices.set({ ...existing, name });
    return { renamed: true };
  },
})

// LOCAL — standard JS try/catch
try {
  workspace.actions.devices.rename({ id, name });
} catch (err) {
  toast.error(String(err));
}

// REMOTE — the throw becomes ActionFailed on the wire
const { data, error } = await remote.devices.rename({ id, name });
if (error) {
  // error.name === 'ActionFailed' — can't distinguish "not found" from
  // "server crashed". If that distinction matters, promote to Err.
  toast.error(error.message);
}
```

**If the remote caller needs to branch on the failure mode, promote the
throw to a typed `Err`:**

```typescript
handler: ({ id, name }) => {
  const existing = tables.devices.get(id);
  if (!existing) return Err(DeviceError.NotFound({ id }));
  tables.devices.set({ ...existing, name });
  return Ok({ renamed: true });
},
```

## The shape matrix

```
                 HANDLER
                 ─────────────────────────────────────────────────────
                 raw              Result                   throw
LOCAL CALLER   ┌─────────────────┬──────────────────────┬───────────────────┐
               │ value           │ {data, error}        │ try/catch or      │
               │ (or await)      │ destructure          │ let it crash      │
               │                 │                      │                   │
REMOTE CALLER  │ {data, error}   │ {data, error}        │ {data, error}     │
               │ error? =        │ error? =             │ error? =          │
               │ ActionFailed    │ E | ActionFailed     │ ActionFailed      │
               │ (transport/bug) │ (your typed E kept)  │ (no typed info)   │
               └─────────────────┴──────────────────────┴───────────────────┘
```

Local mirrors native JS behavior — what you write is what you get. Remote
always hands you an envelope; the only question is how rich the error
channel is.

## Invariants

1. **Local callers never see `ActionFailed`** — it only appears in
   `RemoteAction<A>` signatures and in remote error channels.
2. **Handlers can be sync, async, return raw, return `Result`, or throw** —
   all five are valid. `defineQuery` and `defineMutation` don't care.
3. **Server-side normalization runs exactly once** per RPC, inside
   `attachSync`'s inbound handler. Raw gets `Ok`-wrapped; throws become
   `RpcError.ActionFailed`; Results pass through.
4. **Client-side receivers expect `{data, error}`** — both
   `createRemoteActions` (new path) and `attachSync.rpc()` (legacy peer path)
   consume the envelope. They differ in how they type the error channel.
5. **`ActionFailed` is a `RpcError` variant sourced from `@epicenter/sync`** —
   workspace re-exports it as a type alias. One nominal type across the
   whole system, no re-wrapping.
