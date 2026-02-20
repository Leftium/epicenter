# The Single-or-Array Pattern

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

## How It Works

Normalize at the top of the function, then write all logic against the array. One function, one code path.

```typescript
function createServer(
	clientOrClients: AnyWorkspaceClient | AnyWorkspaceClient[],
	options?: ServerOptions,
) {
	const clients = Array.isArray(clientOrClients)
		? clientOrClients
		: [clientOrClients];

	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	// ... rest of implementation
}
```

The union type `AnyWorkspaceClient | AnyWorkspaceClient[]` is self-documenting. No overloads needed when both forms return the same type.

## Naming Conventions

| Parameter               | Normalized Variable |
| ----------------------- | ------------------- |
| `recordingOrRecordings` | `recordings`        |
| `clientOrClients`       | `clients`           |
| `runOrRuns`             | `runs`              |

## When to Use

**Good fit:** CRUD operations, batch processing, factory functions accepting dependencies.

**Skip when:** Single vs batch have fundamentally different semantics, or you rarely need both forms.

## When Overloads Are Actually Useful

Overloads earn their keep when different inputs produce different output types:

```typescript
function process(input: string): string;
function process(input: number): number;
function process(input: string | number): string | number {
	// ...
}
```

If both overloads return the same type, skip them. The union parameter is clearer.

## Related

- [Skill reference](../../.claude/skills/single-or-array-pattern/SKILL.md)
