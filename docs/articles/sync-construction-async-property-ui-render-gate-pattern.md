# Sync Construction, Async Property, UI Render Gate Pattern

> The initialization of the client is synchronous. The async work is stored as a property you can await, while passing the reference around.

**Related**: [Skill reference](/.claude/skills/sync-construction-async-property-ui-render-gate-pattern/SKILL.md)

A common pattern in UI frameworks: make client initialization synchronous. The async work is stored as a property you can await, while passing the reference around.

This is great for UI libraries because you can have a singleton that you export and import without ever awaiting at the call site.

Use this pattern when creating clients that need async initialization but must be exportable from modules and usable synchronously in UI components.

## The Pattern

```typescript
// client.ts
export const client = createClient();

// Sync access works immediately
client.save(data);
client.load(id);

// The async work (loading from IndexedDB, etc.) tracked here
await client.whenReady;
```

Construction returns immediately. The async initialization (loading from disk, connecting to servers) happens in the background and is tracked via `whenReady`.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  createClient()  →  Returns IMMEDIATELY with:                           │
│                                                                         │
│    ┌─────────────────────────────────────────────────────────────────┐  │
│    │  client                                                         │  │
│    │  ├── .save(data)     ← Function (returned now)                  │  │
│    │  ├── .load(id)       ← Function (returned now)                  │  │
│    │  └── .whenReady      ← Promise  (returned now)                  │  │
│    └─────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│    All three properties exist on the object immediately.                │
│                                                                         │
│    However, save() and load() may internally depend on initialization:  │
│    • They might `await this.whenReady` before doing real work           │
│    • They might throw if called before initialization completes         │
│    • They might queue operations until whenReady resolves               │
│                                                                         │
│    The whenReady promise lets you (or the UI) wait for readiness.       │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│  Timeline                                                               │
│  ────────                                                               │
│                                                                         │
│    t=0  createClient() returns immediately      ┃  Background:          │
│         │                                       ┃                       │
│         │  You have:                            ┃  Initializing...      │
│         │  ├── client.save(data)                ┃  Loading IndexedDB    │
│         │  ├── client.load(id)                  ┃  Connecting server    │
│         │  └── client.whenReady (pending)       ┃        │              │
│         │                                       ┃        │              │
│         │  If you call save() or load() now,    ┃        │              │
│         │  they may internally await            ┃        │              │
│         │  whenReady before doing real work.    ┃        ↓              │
│         │                                       ┃                       │
│    t=N  │                                       ┃  Done!                │
│         └── whenReady resolves ←────────────────┛                       │
│             Now save/load proceed without waiting                       │
└─────────────────────────────────────────────────────────────────────────┘
```

## The Problem With Async Construction

If your constructor were async, you can't export the result:

```typescript
// This doesn't work
export const client = await createClient(); // Top-level await breaks bundlers
```

Which means you can't do the clean import pattern in components:

```typescript
// component-a.svelte
import { client } from '$lib/client';
client.save(data); // Can't work due to top level await
```

So you end up with workarounds. The getter function pattern:

```typescript
let client: Client | null = null;

export async function getClient() {
	if (!client) {
		client = await createClient();
	}
	return client;
}

// Every consumer must await
const client = await getClient();
client.save(data);
```

Every call site needs `await getClient()`. You can't import the client directly. You're passing promises around instead of objects.

## Why This Matters for UI

You can export the client from a module:

```typescript
// client.ts
export const client = createClient();

// component-a.svelte
import { client } from '$lib/client';
client.save(data); // Just use it

// component-b.svelte
import { client } from '$lib/client';
client.load(id); // Same client, no await
```

Simple imports, synchronous access. No getter functions, no `await` at every call site.

## The UI Render Gate

With sync construction, await once at the root of your app:

```svelte
<!-- +layout.svelte -->
<script>
	import { client } from '$lib/client';
</script>

{#await client.whenReady}
	<LoadingSpinner />
{:then}
	{@render children?.()}
{/await}
```

```
┌─────────────────────────────────────────────────────────────────┐
│  +layout.svelte                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  {#await client.whenReady}                                │ │
│  │    <Loading />          ← UI blocked here                  │ │
│  │  {:then}                                                   │ │
│  │    {@render children()}  ← Only renders after sync         │ │
│  │  {/await}                                                  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  Child components:                                               │
│    import { client } from '$lib/client';                         │
│    client.save(data);  ← Safe! Data already loaded               │
└─────────────────────────────────────────────────────────────────┘
```

The gate guarantees: by the time any child component's script runs, the async work is complete. Children use sync access without checking readiness.

> The initialization of the client is synchronous. The async work is stored as a property you can await, while passing the reference around.

## Before and After

**Before: Async construction**

```typescript
// Can't export directly
export const client = await createClient();  // Doesn't work!

// Must use getter function
let client: Client | null = null;
export async function getClient() { ... }

// Every consumer awaits
const client = await getClient();
```

**After: Sync construction with whenReady**

```typescript
// Export directly
export const client = createClient();

// Import and use
import { client } from '$lib/client';
client.save(data);  // No await!

// Await once at the UI boundary
{#await client.whenReady}...{/await}
```

## This Is What y-indexeddb Does

The Yjs ecosystem figured this out. Every official provider follows this pattern:

```typescript
const provider = new IndexeddbPersistence('my-db', doc);
// Constructor returns immediately

provider.on('update', handleUpdate); // Sync access works

await provider.whenSynced; // Wait when you need to
```

They never block construction. The async work is always deferred to a property you can await.

## When to Apply

You're fighting async initialization when you see:

- `await getX()` patterns for objects you want to use synchronously
- Top-level await complaints from bundlers
- Getter functions wrapping singleton access
- Components that can't import a client directly

The fix: make construction synchronous, attach async work to the object via `whenReady`, and await once at the UI boundary.

---

| Aspect         | Async Construction        | Sync + whenReady        |
| -------------- | ------------------------- | ----------------------- |
| Module export  | Can't export directly     | Export the object       |
| Consumer code  | `await getX()` everywhere | Direct import, sync use |
| UI integration | Awkward promise handling  | Single `{#await}` gate  |
| Type signature | `Promise<X>`              | `X` with `.whenReady`   |
