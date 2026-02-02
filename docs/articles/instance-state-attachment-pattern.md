# Don't Use Parallel Maps

**TL;DR**: If you have two Maps with the same key type, **combine them into one Map with a richer value type**.

## The Anti-Pattern

Two Maps tracking the same entities:

```typescript
const clients = new Map<string, Client>();
const initPromises = new Map<string, Promise<void>>();

function getClient(id: string): Client {
	let client = clients.get(id);
	if (!client) {
		client = createClient(id);
		clients.set(id, client);
		initPromises.set(id, initializeAsync(client));
	}
	return client;
}

// Later, somewhere else:
const client = clients.get(id);
await initPromises.get(id); // Hope you didn't forget this Map!
```

```
┌─────────────────┐    ┌─────────────────┐
│ clients         │    │ initPromises    │
│ Map<id, Client> │    │ Map<id, Promise>│
└─────────────────┘    └─────────────────┘
        ↑                      ↑
        └──── Same keys! ──────┘
              Split brain
```

Problems:

- Two data structures to keep in sync
- Cleanup must touch both Maps
- Easy to forget one when adding/removing
- The promise is disconnected from its owner

## The Fix: One Map, Richer Value

Combine related state into a single entry:

```typescript
type ClientEntry = {
	client: Client;
	ready: Promise<void>;
};

const entries = new Map<string, ClientEntry>();

function getClient(id: string): ClientEntry {
	let entry = entries.get(id);
	if (!entry) {
		const client = createClient(id);
		const ready = initializeAsync(client);
		entry = { client, ready };
		entries.set(id, entry);
	}
	return entry;
}

// Later:
const { client, ready } = getClient(id);
await ready;
client.doSomething();
```

```
┌─────────────────────────┐
│ entries                 │
│ Map<id, ClientEntry>    │
│                         │
│   entry.client          │
│   entry.ready           │  ← All state together
└─────────────────────────┘
```

One Map. One entry per id. All related state in one place.

## Cleanup Becomes Simple

Before:

```typescript
function removeClient(id: string) {
	const client = clients.get(id);
	if (client) {
		client.destroy();
		clients.delete(id);
		initPromises.delete(id); // Don't forget!
	}
}
```

After:

```typescript
function removeClient(id: string) {
	const entry = entries.get(id);
	if (entry) {
		entry.client.destroy();
		entries.delete(id); // That's it
	}
}
```

## Code Smells

Apply this pattern when you see:

- Two Maps with matching key types
- `await someOtherMap.get(id)` patterns
- Cleanup code touching multiple Maps for the same entity
- State about an instance stored separately from the instance

## Alternative: Attach to the Instance

If you control the factory function, you can attach the async state directly to the instance:

```typescript
function createClient(id: string) {
	const client = new Client(id);
	const ready = initializeAsync(client);

	return {
		...client,
		ready,
	};
}

const clients = new Map<string, EnhancedClient>();

// Later:
const client = clients.get(id);
await client.ready;
```

This is cleaner when the instance is used everywhere and you want `ready` to be discoverable on the object itself. But the "entry object" approach works even when you don't control the instance type.

## Summary

| Aspect          | Parallel Maps           | Single Entry     |
| --------------- | ----------------------- | ---------------- |
| Data structures | 2+ Maps per entity type | 1 Map            |
| State access    | `otherMap.get(id)`      | `entry.property` |
| Cleanup         | Touch multiple Maps     | One delete       |
| Bug surface     | Forget a Map            | Hard to forget   |

If you're reaching into a separate Map to find data about an entity, that data belongs with the entity.
