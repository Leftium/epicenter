# Move the Boundary Down One Layer

When you're writing code, if you see the usage of callback hooks or hooks like that, you want to be very careful and make sure that you are genuinely sure about the abstraction levels. Hooks are not always wrong. But they often mean one layer owns the decision and another layer owns the effect.

The smell looks like this:

```typescript
createSyncRelay({
  resolveAccess,
  onRoomAccess,
  onStorageBytesChanged,
  onDisconnect,
});
```

The relay wants to stay generic, so it asks the host for decisions through callbacks. But the host still owns the real policy: who may connect, who pays, what gets deleted, what gets logged. The hooks are a sign that the abstraction is sitting one layer too high.

The cleaner version is usually one layer lower:

```typescript
const access = await requireRoomAccess(request);

const result = await sync.handleHttpSync(request, {
  roomName: access.roomName,
});

await recordUsage({
  roomName: access.roomName,
  bytesWritten: result.bytesWritten,
  storageBytes: result.storageBytes,
});

return result.response;
```

The hook disappeared because the host route became the composer.

## Hooks appear when decisions and effects are split apart

The callback version has two owners for one workflow:

```txt
host:
  decides access
  owns billing
  owns route errors

relay:
  accepts sockets
  persists bytes
  counts storage
```

Now the relay needs hooks to tell the host what happened. The more complete the product gets, the more hooks appear.

```typescript
createSyncRelay({
  resolveAccess,
  onRoomAccess,
  onStorageBytesChanged,
  onCapabilityRejected,
  onRoomDeleted,
  onClientDisconnected,
  onCompactionFinished,
});
```

At that point the generic abstraction is not generic anymore. It is a route handler with policy removed and callbacks stapled on.

## The lower boundary is often smaller

Move the reusable part down until it owns only the mechanism.

```typescript
const sync = createSyncEngine({ rooms });
```

The engine does not know users, sessions, plans, or invoices. It knows how to sync a room.

```typescript
await sync.handleWebSocket(request, {
  roomName,
  installationId,
});
```

Everything around that call belongs to the host.

```typescript
app.get('/rooms/:room', async (c) => {
  const user = await requireUser(c);
  await requirePlanAllowsSync(user);

  return sync.handleWebSocket(c.req.raw, {
    roomName: `subject:${user.id}:rooms:${c.req.param('room')}`,
    installationId: c.req.query('installationId'),
  });
});
```

The host route is not a callback. It is the workflow.

## The test is simple

Ask what happens when you delete the hooks.

```txt
Can the caller just do the work before or after calling the reusable function?

Yes:
  the hook probably belongs outside

No:
  the reusable layer may truly own the lifecycle point
```

Some hooks are real. A database transaction hook, a lifecycle event from a framework, or a low-level protocol callback may be the right shape because the lower layer genuinely owns the timing.

But product hooks are suspicious. If the hook is about billing, access, audit, deletion, or user-facing errors, the host likely owns the workflow and should compose the lower-level primitive directly.

## Compose up, do not callback sideways

The direction matters.

```txt
Callback sideways:
  generic relay -> host hook -> generic relay continues

Compose upward:
  host route -> sync engine -> host records result
```

The second version is less magical. The route reads in order. The host owns policy. The reusable code owns mechanics. Nobody has to guess which callback fires when.

That is the design rule I want to keep:

```txt
If hooks are multiplying, move the boundary down one layer.
```
