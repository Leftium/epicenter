# Query Layer

TanStack Query adapters for the few operations a Svelte component actually observes. Everything that is not observed (notifications, deliveries, recording lifecycle, transcription orchestration, transformation runs) lives in `$lib/operations/` as plain async functions.

## What lives here

Only operations consumed via `createQuery(...)` or `createMutation(...)` in a `.svelte` file:

| Module               | Shape    | Where it is observed                                    |
| -------------------- | -------- | ------------------------------------------------------- |
| `audio.ts`           | query    | `RenderAudioUrl.svelte`, `(app)/+page.svelte`, `EditRecordingModal.svelte` |
| `text.ts`            | query    | `transform-clipboard/+page.svelte`                      |
| `download.ts`        | mutation | `RecordingRowActions.svelte`                            |
| `transcription.ts`   | mutation | `recordings/+page.svelte`, `RecordingRowActions.svelte` |
| `transformer.ts`     | mutation | `TransformationPicker.svelte`, `Test.svelte`            |
| `client.ts`          | infra    | `QueryClient` + `defineQuery` / `defineMutation`        |
| `transcription-errors/` | leaves | error transformers shared with `operations/transcribe`  |
| `desktop/`           | barrel   | desktop-only RPC (separate concern, not part of `rpc`)  |

## The `rpc` barrel

`rpc` is a namespaced import barrel for IntelliSense over the observed query surface. It does not include orchestrators, side effects, or use cases.

```ts
import { rpc } from '$lib/query';

// Reactive in a component
const audio = createQuery(() =>
  rpc.audio.getPlaybackUrl(() => recordingId).options,
);

// Reactive mutation observed in batch UI
const transcribeRecordings = createMutation(
  () => rpc.transcription.transcribeRecordings.options,
);
```

## Authoring rules

1. A module belongs here if and only if it exports a `defineQuery`/`defineMutation` object that one or more `.svelte` files observe via `createQuery(...)` / `createMutation(...)`. Otherwise it belongs in `$lib/operations/`.
2. Adapters are leaves: a file in `query/` may import from `query/client` but not from another sibling in `query/`. Cross-adapter coordination is an operation; put it in `operations/`.
3. Adapters do not import from `$lib/operations/*`. The dependency direction is one-way: `operations -> query -> services / state`.
4. Each adapter wraps services with: error transformation to `WhisperingError`, cache keys, and (for queries) parameterization.

## Observing an operation's lifecycle without putting it here

Rule 3 forbids `query/` from importing `operations/`. So when a component needs `mutation.isPending` for an operation that already lives in `$lib/operations/` (because it orchestrates side effects across notify, sound, settings, pipeline, etc.), do not move the operation into `query/`. Instead, instantiate the mutation inline in the component:

```svelte
<script lang="ts">
  import { createMutation } from '@tanstack/svelte-query';
  import {
    startManualRecording,
    stopManualRecording,
  } from '$lib/operations/recording';

  const startMutation = createMutation(() => ({ mutationFn: startManualRecording }));
  const stopMutation  = createMutation(() => ({ mutationFn: stopManualRecording  }));
  const isPreparing = $derived(startMutation.isPending || stopMutation.isPending);
</script>

<Button disabled={isPreparing} onclick={...}>...</Button>
```

When to put the mutation here vs. inline:

- **Here (`$lib/query/<topic>.ts`)**: the mutation is a thin adapter over a service call. Shared cache keys, shared error transformation, observed in multiple components. Example: `transcription.ts`.
- **Inline in the component**: the work lives in `$lib/operations/` because it orchestrates several side effects, and only this component needs the lifecycle. The mutation is just a TanStack wrapper around `mutationFn: someOperation`; no cache key, no error transformation, no cross-component reuse.

## Error transformation

Services return their own typed errors. Adapters transform service errors into `WhisperingError` so toast/notification consumers can render them uniformly.

```ts
transcribeRecording: defineMutation({
  mutationFn: async (recording: Recording) => {
    const { data, error } = await services.blobs.audio.getBlob(recording.id);
    if (error) {
      return WhisperingErr({
        title: '⚠️ Failed to fetch audio',
        description: `Unable to load audio for recording: ${error.message}`,
      });
    }
    // ...
  },
});
```

## Imperative escape hatches

Every `defineQuery`/`defineMutation` returned object is also directly callable and exposes `.fetch()` / `.execute()` for imperative use. Prefer plain async functions in `$lib/operations/` for code that is not observed by a component, instead of reaching for `.execute()` on a mutation.

## Architecture context

```
UI (.svelte)
  │  createQuery(() => rpc.<x>.options)        ← only here
  │  createMutation(() => rpc.<y>.options)
  │  await <operation>(...)                    ← everywhere else
  ▼
$lib/operations/*   plain async use cases (notify, delivery, recording, upload,
                    pipeline, transcribe, transformation-clipboard, analytics,
                    sound, shortcuts)
  ▼
$lib/query/*        TanStack adapters (this directory)
  ▼
$lib/services/*     pure, Result-typed
$lib/state/*        reactive (Svelte runes, Yjs)
```

See `$lib/services/README.md` for the service layer.
