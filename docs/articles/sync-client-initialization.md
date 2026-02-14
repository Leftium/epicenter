# Avoid Async Client Initialization in UI Frameworks: Synchronous Client Initialization with Deferred Sync

## The Problem with Async Initialization

In UI frameworks, we try our best to avoid async client initialization. Even clients whose operations are almost all async will often have their initialization be synchronous:

```typescript
const db = drizzle(env.DB);
const result = await db.select().from(users).all();
```

The reason is that when you have an async client, you can't import it.

In a single-page application, you typically want to create a client once and use it everywhere. The ideal pattern looks like this:

```typescript
// client.ts
export const client = createClient();

// component-a.svelte
import { client } from '$lib/client';
client.save(data);

// component-b.svelte
import { client } from '$lib/client';
client.load(id);
```

Simple imports, synchronous access. But what if `createClient()` is async? You can't write:

```typescript
// client.ts
export const client = await createClient(); // Top-level await doesn't work in most bundlers
```

Top-level await is either unsupported or creates problems with module loading order. You end up with a client that can't be imported like a normal value. This forces everyone into workarounds.

You end up with some strange workarounds. Here are patterns I see all the time in UI frameworks:

### Workaround 1: The Getter Function

```typescript
// db.ts
let client: DatabaseClient | null = null;

export async function getClient() {
  if (!client) {
    client = await createDatabaseClient();
  }
  return client;
}

// component.svelte
<script>
  import { getClient } from '$lib/db';

  async function saveData() {
    const client = await getClient();
    await client.save(data);
  }
</script>
```

Every function that needs the client has to call and await the getter. You can't just import the client; you have to go through this ceremony every time.

### Workaround 2: Context Provider Pattern

```svelte
<!-- DatabaseProvider.svelte -->
<script module>
  import { createContext } from 'svelte';

  const [getDatabaseClient, setDatabaseClient] = createContext<DatabaseClient>();

  export { getDatabaseClient };
</script>

<script>
  import { onMount } from 'svelte';
  import { createDatabaseClient } from '$lib/db';

  let client: DatabaseClient | null = $state(null);

  onMount(async () => {
    client = await createDatabaseClient();
    setDatabaseClient(client);
  });

  let { children } = $props();
</script>

{#if client}
  {@render children?.()}
{:else}
  <LoadingSpinner />
{/if}

<!-- +layout.svelte -->
<script>
  import DatabaseProvider from '$lib/DatabaseProvider.svelte';
</script>

<DatabaseProvider>
  {@render children?.()}
</DatabaseProvider>

<!-- SomeComponent.svelte -->
<script>
  import { getDatabaseClient } from '$lib/DatabaseProvider.svelte';

  const client = getDatabaseClient();
  // Use client - guaranteed to be initialized because provider only renders children after init
</script>
```

You wrap the app in a provider that initializes the client, waits for it to be ready, and provides it via context. Child components can safely access the client via the exported `getDatabaseClient()` function. Svelte 5's `createContext` returns a type-safe `[get, set]` tuple, so you don't need string keys or manual type annotations. This is a solid pattern and widely used in Svelte apps. The downside: you need the provider wrapper, and accessing the client requires the context getter instead of a direct import.

### Workaround 3: Await in Every Method

```typescript
// db.ts
function createDatabaseClient() {
	const initPromise = initializeConnection(); // Kicks off async work immediately

	return {
		async save(data: Data) {
			const db = await initPromise; // Waits for init to complete
			return db.save(data);
		},
		async load(id: string) {
			const db = await initPromise;
			return db.load(id);
		},
	};
}

export const client = createDatabaseClient();

// component.svelte
import { client } from '$lib/db';

// Internally awaits the init promise that was kicked off on construction
await client.save(data);
```

You make construction synchronous by kicking off the initialization promise immediately, then every method awaits it before doing work. This is actually a pretty good pattern, and I'd recommend it in many cases. It lets you export a synchronous client that can be imported anywhere. The downside is verbosity: you have to remember to await the init promise in every single method you add.

### The Core Issue

UI frameworks want synchronous access to things. You can't easily export and import an awaited value. Components need to access clients immediately, not after an await. All these workarounds are trying to paper over that fundamental mismatch.

## The `whenReady` Pattern

[y-indexeddb](https://github.com/yjs/y-indexeddb) (the IndexedDB persistence layer for Yjs) solves this brilliantly. Here's how it works:

```typescript
const provider = new IndexeddbPersistence('my-db', doc);

// Constructor returns immediately - you can use it right away
provider.on('update', () => {
	// Handle updates
});

// But if you need to wait for initial sync:
await provider.whenSynced;
// Now the document is fully loaded from IndexedDB
```

The constructor returns immediately. The async work (loading from IndexedDB) happens in the background. When you need to wait for it, you have `whenSynced`.

This is the pattern: synchronous construction, deferred sync.

The reason is that asynchronous construction is painful.

Using this pattern, you can export and import it like any other value:

```typescript
// client.ts
export const client = createClient();

// anywhere.ts
import { client } from './client';

// Use it synchronously
client.on('update', handleUpdate);

// Or wait for it to be ready
await client.whenReady;
```

**Browser vs Node Initialization:**

In my .node.ts and .browser.ts files:

The browser `createClient` uses sync creation + `whenReady` to allow **immediate UI rendering** while data loads in the background. This is intentional:

- Browser providers like y-indexeddb are designed to return synchronously
- They expose a `whenReady` promise for tracking when data is loaded
- This allows your UI to render immediately with loading states, then update when data arrives

Node uses async creation because scripts and servers can just await:

- When `createClient()` returns, everything is ready
- No `whenReady` needed because initialization is fully awaited
- This is simpler for CLI scripts, migrations, and server startup

**Example:**

```typescript
// Browser: sync creation, deferred sync
const client = createClient(workspace);
// UI can render immediately here (maybe with loading state)
await client.whenReady;
// Now all data is loaded

// Node: async creation, everything ready
const client = await createClient(workspace);
// Everything is ready, no waiting needed
```

## Await Once at the Root

Once you have a client with this structure, the cleanest approach is to await once at the root of your application:

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

Wait once at the root. After that, the entire app can assume the client is ready. This gives you:

1. **Single await point**: You wait once, then you're done
2. **Guaranteed readiness**: When the UI renders, the client is ready
3. **Simpler mental model**: No need to think "is this ready?" at every call site
4. **Better UX**: One loading state for the whole app, not random delays throughout

## The Export Pattern

This is the key insight: you can synchronously export the client, but asynchronously ensure it's ready:

```typescript
// client.ts
export const client = createClient();

// +layout.svelte
{#await client.whenReady}
  Loading...
{:then}
  <App />
{/await}

// any-component.svelte
<script>
  import { client } from '$lib/client';
</script>

<button onclick={() => client.saveData(data)}>
  <!-- No await needed - this component only renders after client.whenReady resolves -->
  Save
</button>
```

No `await getClient()` everywhere. No wondering if the client is initialized. Just import it and use it. The component won't even render until the root `{#await}` block resolves, so by the time this button is clickable, the client is guaranteed to be ready.

## Comparison: Before and After

**Before (Async Everywhere)**

```typescript
// db.ts
let client: Client | null = null;

export async function getClient() {
	if (!client) {
		client = await Client.create();
	}
	return client;
}

// component.svelte
async function handleSave() {
	const client = await getClient();
	await client.save(data);
}

async function handleLoad() {
	const client = await getClient();
	return await client.load(id);
}
```

**After (Sync Construction)**

```typescript
// db.ts
export const client = createClient();

// +layout.svelte
{#await client.whenReady}Loading...{:then}<App />{/await}

// component.svelte
function handleSave() {
  client.save(data); // Just use it
}

function handleLoad() {
  return client.load(id); // No await needed at call site
}
```

The difference is clarity. You still have async work (the methods themselves are async), but you don't have async initialization. The client exists from the moment you import it.

## The Lesson

Not every async operation needs to block construction. When you're building clients that UI frameworks will consume, consider this pattern:

1. Construct synchronously
2. Initialize asynchronously in the background
3. Expose a `whenReady` promise for consumers who need to wait
4. In most cases, wait once at the root and forget about it

This is what Yjs figured out with IndexedDB persistence. It's a pattern worth adopting anywhere you have clients that UI code needs to access.

## How Epicenter Implements This

Epicenter uses this pattern for browser clients, with a twist: it aggregates `whenReady` promises from all providers.

### Browser: Synchronous Construction with Deferred Sync

In the browser, `createEpicenterClient` and `createWorkspaceClient` are **synchronous**:

```typescript
// Browser: No await needed
const client = createEpicenterClient(epicenter);

// Client is immediately usable
const pages = client.pages.getAllPages();

// But you can wait for providers to sync if needed
await client.pages.whenReady;
```

Why synchronous? Because browser modules can't use top-level await effectively. The client needs to be exportable and importable like any other value.

### Node.js: Async Construction

In Node.js, `createEpicenterClient` and `createWorkspaceClient` are **async**:

```typescript
// Node.js: Await required
const client = await createEpicenterClient(epicenter);

// Everything is fully initialized
const pages = client.pages.getAllPages();

// No whenReady needed - providers are already synced
```

Why async? Node.js supports top-level await, and files evaluate top-down. Scripts, CLIs, and servers can simply await initialization at the entry point. There's no module import constraint forcing synchronous construction.

### Provider `whenReady` Aggregation

Browser workspace clients aggregate `whenReady` promises from all providers:

```typescript
// In client.browser.ts
export function createWorkspaceClient(config) {
	const ydoc = new Y.Doc();
	const syncPromises: Promise<void>[] = [];

	// Initialize providers
	for (const [name, providerFn] of Object.entries(config.providers)) {
		const exports = providerFn({ ydoc, ...context });

		// Collect whenReady promises from providers that have them
		if (exports?.whenReady) {
			syncPromises.push(exports.whenReady);
		}
	}

	// Aggregate all sync promises
	const whenReady =
		syncPromises.length > 0
			? Promise.all(syncPromises).then(() => {})
			: Promise.resolve();

	return {
		...workspaceExports,
		whenReady,
		destroy,
	};
}
```

This means providers can optionally expose a `whenReady` promise. The workspace client collects them all and exposes a single `whenReady` that resolves when every provider is ready.

### Providers That Use `whenReady`

The IndexedDB persistence provider is the canonical example:

```typescript
// In persistence/web.ts
export function createIndexedDBPersistence({ ydoc, id }) {
	const persistence = new IndexeddbPersistence(id, ydoc);

	return {
		whenReady: persistence.whenSynced.then(() => {
			console.log(`[Persistence] IndexedDB synced for ${id}`);
		}),
		destroy: () => persistence.destroy(),
	};
}
```

The y-indexeddb library's `IndexeddbPersistence` class exposes `whenSynced`. Epicenter adapts it to `whenReady` at the boundary.

### The Type Difference

Browser and Node workspace clients have different types to reflect this:

```typescript
// Browser WorkspaceClient - includes whenReady
type WorkspaceClient<TExports> = TExports & {
	$ydoc: Y.Doc;
	whenReady: Promise<void>; // Present in browser
	destroy: () => Promise<void>;
};

// Node WorkspaceClient - no whenReady needed
type WorkspaceClient<TExports> = TExports & {
	$ydoc: Y.Doc;
	// No whenReady - fully awaited at construction
	destroy: () => Promise<void>;
};
```

This type difference is intentional. Browser code can rely on `whenReady` existing; Node code doesn't need it because initialization is already awaited.

### Using It in Svelte

The pattern from earlier works exactly as expected:

```svelte
<!-- +layout.svelte -->
<script>
	import { client } from '$lib/epicenter';
</script>

{#await client.pages.whenReady}
	<LoadingSpinner />
{:then}
	{@render children?.()}
{/await}
```

Or if you have multiple workspaces:

```svelte
{#await Promise.all([client.pages.whenReady, client.auth.whenReady])}
	<LoadingSpinner />
{:then}
	<App />
{/await}
```

### Why Two Implementations?

Epicenter maintains separate browser and Node implementations (`client.browser.ts` and `client.node.ts`) rather than a single polymorphic implementation. This is intentional:

1. **Maximum type safety**: Browser clients have `whenReady`, Node clients don't. The types reflect reality.
2. **No runtime polymorphism**: No `if (typeof window !== 'undefined')` checks. Bundlers select the right file via package.json exports.
3. **Clear mental model**: If you're in the browser, you get browser semantics. If you're in Node, you get Node semantics.

The trade-off is some code duplication, but each file is self-contained and readable top-to-bottom without jumping between shared abstractions.
