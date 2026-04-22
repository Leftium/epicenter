---
name: attach-primitive
description: Contract and invariants for `attach*` / `create*` composition primitives — the building blocks composed inside `defineDocument`.
---

# Attach Primitives

Every persistence, sync, materializer, and binding in `packages/workspace` (plus session-shaped primitives in `packages/cli`) follows one of four shapes. Pick the narrowest shape that describes what you're attaching to and match the invariants exactly.

## Naming

| Prefix     | Shape                                | Use when                                                         |
| ---------- | ------------------------------------ | ---------------------------------------------------------------- |
| `attach*`  | `attachX(subject, opts) → XAttachment` | One-shot capability mount. Fixed surface, no chainable config.   |
| `create*`  | `createX(ctx, config) → XBuilder`      | Chainable builder (`.table()/.kv()/...`). Configuration is incremental. |

Both return plain objects. `attach*` is overwhelmingly the common case. Reach for `create*` only when the API needs incremental per-entity configuration (materializers are the only current example).

## The four attach variants

All four obey the invariants below. Pick the one whose first argument actually describes the subject being modified.

### Variant 1 — ydoc-bound (canonical)

```ts
export function attachX(ydoc: Y.Doc, opts: XOptions): XAttachment;
```

Most primitives: `attachIndexedDb`, `attachSqlite`, `attachSync`, `attachBroadcastChannel`, `attachEncryption`, `attachTable(s)`, `attachKv`, `attachAwareness`, `attachRichText`, `attachPlainText`, `attachTimeline`. Teardown via `ydoc.once('destroy', ...)`.

### Variant 2 — ydoc + coordinator

```ts
export function attachX(
  ydoc: Y.Doc,
  coordinator: YCoordinator,
  opts: XOptions,
): XAttachment;
```

Used when the primitive needs a sibling attachment as a dependency but still owns a slice of the ydoc. Examples: `attachEncryptedTable(ydoc, encryption, def)`, `attachEncryptedKv(ydoc, encryption, defs)`, `attachEncryptedTables(ydoc, encryption, defs)`. Teardown still via `ydoc.once('destroy')`; the coordinator owns its own lifecycle.

### Variant 3 — attachment-on-attachment

```ts
export function attachX(
  subject: SomeAttachment,
  opts: XOptions,
): XAttachment;
```

Modifies an existing attachment without touching the ydoc directly. Example: `attachSessionUnlock(encryption, { sessions, serverUrl, waitFor })` — applies the stored CLI session's keys to an `EncryptionAttachment`. No teardown needed because there are no event listeners or resources to free; the op is one-shot async (returns a `whenApplied` barrier and nothing else).

### Variant 4 — builder (create\*)

```ts
export function createX(
  ctx: { tables; definitions?; kv?; whenReady: Promise<void> },
  config: XConfig,
): XBuilder; // { whenFlushed, table(), kv(), pushFrom..., pullTo..., [Symbol.dispose]() }
```

Materializers: `createMarkdownMaterializer`, `createSqliteMaterializer`. The ctx provides the pieces they observe (tables, kv, readiness barrier), not the ydoc — they don't own the doc lifecycle, they ride on one. Teardown via a `[Symbol.dispose]()` method on the builder (unsubscribes table observers). `whenFlushed` replaces `whenLoaded` — "initial materialize complete."

## Invariants (all four variants)

1. **Synchronous return.** Construction never awaits. Async work goes into `when*` promises on the returned object.
2. **Teardown hooked to the correct lifecycle.**
   - Variants 1, 2: `ydoc.once('destroy', ...)`. Never expose a `.destroy()` method on the attachment.
   - Variant 3: usually no teardown. If the primitive does hold listeners, use the subject attachment's own disposal signal.
   - Variant 4: `[Symbol.dispose]()` method on the builder, unsubscribes observers.
3. **Idempotent cleanup.** If the underlying library also registers a destroy handler (like `y-indexeddb`), your handler must be safe to run alongside it.
4. **Plain data returned.** The attachment is a record of promises, functions, and occasionally mutable state. No ES classes, no getters that lazy-init.
5. **No id option.** For ydoc-bound variants, `ydoc.guid` is the identity — read it off the doc, don't take it again as an option.
6. **Barrier naming is semantic, not mechanical.** Pick the name that describes the actual event:
   - `whenLoaded` — local state replayed into the ydoc (IDB, SQLite)
   - `whenConnected` — remote transport up + first exchange done (sync)
   - `whenApplied` — configuration action completed (session-unlock)
   - `whenFlushed` — initial side-effect pass done (materializer)
   - `whenDisposed` — teardown settled (any variant with async cleanup)
   - `whenReady` — bundle-level aggregate only; not on individual attachments

## Composition inside `defineDocument`

Primitives compose inside a build closure:

```ts
const factory = defineDocument((id: string) => {
  const ydoc       = new Y.Doc({ guid: id, gc: false });
  const encryption = attachEncryption(ydoc);                                // variant 1
  const tables     = attachEncryptedTables(ydoc, encryption, schema);       // variant 2
  const idb        = attachIndexedDb(ydoc);                                 // variant 1
  const unlock     = attachSessionUnlock(encryption, {                      // variant 3
    sessions, serverUrl, waitFor: idb.whenLoaded,
  });
  const sync       = attachSync(ydoc, {                                     // variant 1
    url, getToken,
    waitFor: Promise.all([idb.whenLoaded, unlock.whenApplied]),
  });
  const markdown   = createMarkdownMaterializer(                            // variant 4
    { tables, kv, whenReady: sync.whenConnected },
    { dir },
  ).table('posts', { serialize });

  return {
    ydoc, tables, encryption, idb, sync, markdown,
    whenReady:    Promise.all([idb.whenLoaded, unlock.whenApplied, sync.whenConnected]).then(() => {}),
    whenDisposed: Promise.all([idb.whenDisposed, sync.whenDisposed, encryption.whenDisposed]).then(() => {}),
    [Symbol.dispose]() { ydoc.destroy(); },
  };
});

export const workspace = factory.open('my-app');
```

The bundle aggregates child `whenLoaded` / `whenConnected` / `whenApplied` into one `whenReady`, and child `whenDisposed` into one `whenDisposed`. Consumers only await the bundle-level barriers.

## The `waitFor` convention

Primitives that perform a gated startup (sync, session-unlock) accept `waitFor?: Promise<unknown>` in their options. The primitive awaits it before taking its first action. This replaces the old extension-chain "init pipeline" — sequencing is now explicit at the call site, visible in one file, no hidden ordering.

Use it whenever a primitive's startup must follow another's. Examples:
- `attachSync` after local hydrate: `waitFor: idb.whenLoaded`
- `attachSessionUnlock` after hydrate (so stored keys don't clobber freshly-hydrated plaintext mid-replay): `waitFor: persistence.whenLoaded`
- `attachSync` after both hydrate AND unlock: `waitFor: Promise.all([idb.whenLoaded, unlock.whenApplied])`

## Anti-patterns

- **Don't revive `ExtensionContext` / `RawExtension` / `defineExtension`.** Those were deleted for a reason — the lifecycle framework added a registration indirection that primitives don't need.
- **Don't wrap attachments in a `createWorkspace().with(...)` chain.** Compose inline in the factory.
- **Don't expose `dispose()` on a variant-1/2 attachment.** Destroy the Y.Doc.
- **Don't duck-type an attachment.** If you need to brand it, use a `Symbol.for` marker. See `skills/typescript` — runtime shape-checking is a code smell.
- **Don't take an `id` on a ydoc-bound primitive.** Use `ydoc.guid`.
- **Don't use `createX` for a fixed-surface attachment.** The `create*` prefix signals chainable configuration. If there's nothing to chain, use `attach*`.
- **Don't use `attachX` for a builder.** If you return `.table()/.kv()/.kvScope()`, that's a builder — name it `create*`.

## Reference implementations

- `packages/workspace/src/document/attach-indexed-db.ts` — canonical variant 1 (~40 lines).
- `packages/workspace/src/document/attach-sync.ts` — variant 1 with `whenConnected` + `waitFor`.
- `packages/workspace/src/document/attach-encryption.ts` — variant 1 with internal state (keyring cache).
- `packages/workspace/src/document/attach-encrypted.ts` — variant 2 (`attachEncryptedTable(s)` + `attachEncryptedKv`).
- `packages/cli/src/primitives/attach-session-unlock.ts` — variant 3 (no teardown, single `whenApplied` barrier).
- `packages/workspace/src/document/materializer/markdown/materializer.ts` — variant 4 (builder with `.table()/.kv()` chain).
- `apps/whispering/src/lib/client.ts` — full composition inside `defineDocument`.
