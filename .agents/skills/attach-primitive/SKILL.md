---
name: attach-primitive
description: Contract and invariants for `attach*(ydoc, opts) → Attachment` functions — the building blocks composed inside `defineDocument`.
---

# Attach Primitives

Every persistence, sync, materializer, and binding in `packages/workspace` follows the same shape. If you're adding a new one — or porting old `defineExtension` code — match this contract exactly.

## Signature

```ts
export type XAttachment = {
  // Optional readiness signal — "local state hydrated" or "remote connected"
  whenLoaded?: Promise<void>;
  whenConnected?: Promise<void>;
  // Mandatory when the primitive owns async teardown (file handles, sockets, DBs)
  whenDisposed?: Promise<void>;
  // Primitive-specific surface (clearLocal, read/write, etc.)
};

export function attachX(ydoc: Y.Doc, opts: XOptions): XAttachment {
  // 1. Synchronous construction — no top-level await
  const resource = new Something(ydoc.guid, ydoc, opts);

  // 2. Teardown hooked to ydoc lifecycle
  const { promise: whenDisposed, resolve } = Promise.withResolvers<void>();
  ydoc.once('destroy', async () => {
    try { await resource.destroy(); } finally { resolve(); }
  });

  // 3. Return plain object — no classes, no `this`
  return { whenLoaded: resource.whenSynced.then(() => {}), whenDisposed };
}
```

## Invariants

1. **Synchronous return.** Construction never awaits. Async work goes into `whenX` promises on the returned object.
2. **Teardown via `ydoc.once('destroy', ...)`.** Never expose a `.destroy()` method on the attachment — destroying the Y.Doc is the one and only disposal trigger.
3. **Idempotent cleanup.** If the underlying library also registers a destroy handler (like `y-indexeddb`), your handler must be safe to run alongside it.
4. **Plain data returned.** The attachment is a record of promises and functions. No ES classes, no getters that lazy-init.
5. **`ydoc.guid` is the identity.** Don't take an `id` option — read it off the doc.

## Composition

Primitives compose inside a `defineDocument` build closure:

```ts
const factory = defineDocument((id: string) => {
  const ydoc = new Y.Doc({ guid: id, gc: false });
  const encryption = attachEncryption(ydoc);
  const tables = attachEncryptedTables(ydoc, encryption, schema);
  const idb = attachIndexedDb(ydoc);
  attachBroadcastChannel(ydoc);

  return {
    ydoc, tables, encryption, idb,
    whenReady: idb.whenLoaded,
    whenDisposed: Promise.all([idb.whenDisposed, encryption.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});
```

The bundle aggregates child `whenLoaded` / `whenDisposed` into one `whenReady` / `whenDisposed` — consumers only await the bundle.

## Materializer variant

Materializers observe tables rather than the raw doc. They take `{ tables, definitions?, kv?, whenReady }` instead of a `ydoc`:

```ts
const markdown = createMarkdownMaterializer(
  { tables, kv, whenReady },
  { dir: MARKDOWN_DIR },
).table('files', { serialize });
```

Still synchronous construction. Still `whenDisposed` for flush-on-exit. The input shape differs because they don't own doc lifecycle — they ride on one.

## Anti-patterns

- **Don't revive `ExtensionContext` / `RawExtension` / `defineExtension`.** Those were deleted for a reason — the lifecycle framework added a registration indirection that primitives don't need.
- **Don't wrap attachments in a `createWorkspace().with(...)` chain.** Compose inline in the factory.
- **Don't expose `dispose()` on the attachment.** Destroy the Y.Doc.
- **Don't duck-type an attachment.** If you need to brand it, use a `Symbol`. See `skills/typescript` — runtime shape-checking is a code smell.

## Reference implementations

- `packages/workspace/src/document/attach-indexed-db.ts` — the canonical 40-line example.
- `packages/workspace/src/document/attach-sync.ts` — network variant with `whenConnected`.
- `packages/workspace/src/document/attach-encryption.ts` — state-owning variant.
- `apps/whispering/src/lib/client.ts` — full composition inside `defineDocument`.
