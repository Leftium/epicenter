# Advanced Query Patterns

## When to Read This

Read when implementing cache updates, defining query/mutation patterns, wiring the RPC namespace, or coordinating multi-service query-layer APIs.

## Cache Management

### Optimistic Updates Pattern

Update the cache immediately, then sync with the owning service or operation:

```typescript
export const recordingKeys = defineKeys({
	all: ['recordings'],
	latest: ['recordings', 'latest'],
	byId: (id: string) => ['recordings', id] as const,
	create: ['recordings', 'create'],
});

export const recordings = {
	create: defineMutation({
		mutationKey: recordingKeys.create,
		mutationFn: async (params: { recording: Recording; audio: Blob }) => {
			const { error } = await services.recordings.create(params);
			if (error) return Err(error);

			queryClient.setQueryData<Recording[]>(recordingKeys.all, (oldData) => [
				...(oldData ?? []),
				params.recording,
			]);
			queryClient.setQueryData<Recording>(
				recordingKeys.byId(params.recording.id),
				params.recording,
			);

			queryClient.invalidateQueries({ queryKey: recordingKeys.all });
			queryClient.invalidateQueries({ queryKey: recordingKeys.latest });

			return Ok(undefined);
		},
	}),
};
```

### Query Keys Pattern

Define one exported key map beside the module that owns the cache identity:

```typescript
export const audioKeys = defineKeys({
	playbackUrl: (id: string) => ['audio', 'playbackUrl', id] as const,
});
```

Static keys do not need `as const`; key factories use `as const` when literal positions matter.

## Query Definition Examples

### Basic Query

```typescript
export const audio = {
	getPlaybackUrl: (id: Accessor<string>) =>
		defineQuery({
			queryKey: audioKeys.playbackUrl(id()),
			queryFn: () => services.blobs.audio.ensurePlaybackUrl(id()),
		}),
};
```

### Query with Initial Data

```typescript
getLatest: defineQuery({
	queryKey: recordingKeys.latest,
	queryFn: () => services.recordings.getLatest(),
	initialData: () =>
		queryClient
			.getQueryData<Recording[]>(recordingKeys.all)
			?.toSorted(
				(a, b) =>
					new Date(b.timestamp).getTime() -
					new Date(a.timestamp).getTime(),
			)[0] ?? null,
	initialDataUpdatedAt: () =>
		queryClient.getQueryState(recordingKeys.all)?.dataUpdatedAt,
});
```

### Parameterized Query with Accessor

```typescript
getById: (id: Accessor<string>) =>
	defineQuery({
		queryKey: recordingKeys.byId(id()),
		queryFn: () => services.recordings.getById(id()),
		initialData: () =>
			queryClient
				.getQueryData<Recording[]>(recordingKeys.all)
				?.find((recording) => recording.id === id()) ?? null,
	});
```

### Mutation Over an Operation

Use RPC when shared UI needs mutation state over an operation:

```typescript
export const transcriptionKeys = defineKeys({
	isTranscribing: ['transcription', 'isTranscribing'],
});

export const transcription = {
	transcribeRecording: defineMutation({
		mutationKey: transcriptionKeys.isTranscribing,
		mutationFn: async (recording: Recording) => {
			recordings.update(recording.id, { transcriptionStatus: 'TRANSCRIBING' });

			const { data, error } = await transcribeAudio(recording.id);
			if (error) {
				recordings.update(recording.id, { transcriptionStatus: 'FAILED' });
				return Err(error);
			}

			recordings.update(recording.id, {
				transcript: data,
				transcriptionStatus: 'DONE',
			});
			return Ok(data);
		},
	}),
};
```

## RPC Namespace

All adapters are bundled into a unified `rpc` namespace:

```typescript
// rpc/index.ts
export const rpc = {
	audio,
	download,
	transcription,
	transformer,
} as const;

// Usage anywhere in the app
import { rpc } from '$lib/rpc';

// Reactive in components
const query = createQuery(() =>
	rpc.audio.getPlaybackUrl(() => recordingId).options,
);

// Imperative in handlers/workflows
const { data, error } = await rpc.download.downloadRecording(recording);
```

Keep user delivery effects outside `$lib/rpc`. Components and operations use `$lib/report` when they need to show errors, loading state, sounds, notifications, or other user-facing side effects.
