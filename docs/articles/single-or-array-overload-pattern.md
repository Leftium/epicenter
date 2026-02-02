# The Single-or-Array Overload Pattern

Accept both single items and arrays, normalize internally, process uniformly.

## The Pattern

```typescript
function deleteRecordings(recordings: Recording | Recording[]) {
	const recordingsArray = Array.isArray(recordings) ? recordings : [recordings];

	// Core logic works on array
	const ids = recordingsArray.map((r) => r.id);
	return db.recordings.bulkDelete(ids);
}
```

Callers get flexibility:

```typescript
deleteRecordings(singleRecording); // Works
deleteRecordings([rec1, rec2, rec3]); // Also works
```

## Two Approaches

### Option 1: Normalize Inline

When the implementation is simple, normalize and execute in the same function:

```typescript
delete: async (recordingOrRecordings) => {
  const recordings = Array.isArray(recordingOrRecordings)
    ? recordingOrRecordings
    : [recordingOrRecordings];

  const ids = recordings.map((r) => r.id);
  return tryAsync({
    try: () => db.recordings.bulkDelete(ids),
    catch: (error) => DbServiceErr({ message: `Error: ${error}` }),
  });
},
```

### Option 2: Extract to Internal Function

When the implementation is complex, keep normalization thin and delegate:

```typescript
// Public API: accepts single or array
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}

// Internal: array-only, all real logic here
function createServerInternal(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const workspaces: Record<string, AnyWorkspaceClient> = {};

	for (const client of clients) {
		workspaces[client.id] = client;
		// ... complex setup logic
	}

	// ... rest of implementation
}
```

This keeps the public API clean and the core logic focused on one code path.

## Explicit Overloads (Optional)

For cleaner IDE signatures, add explicit overloads:

```typescript
function createServer(
	client: AnyWorkspaceClient,
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clients: AnyWorkspaceClient[],
	options?: ServerOptions,
): ReturnType<typeof createServerInternal>;
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];
	return createServerInternal(clients, options);
}
```

Skip overloads when the union type is clear enough.

## Naming Conventions

| Parameter               | Normalized Variable |
| ----------------------- | ------------------- |
| `recordingOrRecordings` | `recordings`        |
| `clientOrClients`       | `clients`           |
| `runOrRuns`             | `runs`              |

## When to Use

**Good fit:** CRUD operations, batch processing, factory functions accepting dependencies.

**Skip when:** Single vs batch have fundamentally different semantics, or you rarely need both forms.

## Related

- [Skill reference](../../.claude/skills/single-or-array-pattern/SKILL.md)
