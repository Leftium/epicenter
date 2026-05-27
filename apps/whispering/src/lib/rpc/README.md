# RPC Layer

Thin, side-effect-free TanStack adapters over services. Each module here wraps a service call with the things components need to observe it reactively: cache keys for queries, error transformation, and cache invalidation for mutations. Folder name matches the exported barrel: `import { rpc } from '$lib/rpc'`.

## What lives here

| Module             | Shape    | Where it is observed                                                       |
| ------------------ | -------- | -------------------------------------------------------------------------- |
| `audio.ts`         | query    | `RenderAudioUrl.svelte`, `(app)/+page.svelte`, `EditRecordingModal.svelte` |
| `download.ts`      | mutation | `RecordingRowActions.svelte`                                               |
| `transcription.ts` | mutation | `recordings/+page.svelte`, `RecordingRowActions.svelte`                    |
| `transformer.ts`   | mutation | `TransformationPicker.svelte`, `Test.svelte`                               |
| `client.ts`        | infra    | `QueryClient` + `defineQuery` / `defineMutation`                           |

## The `rpc` barrel

```ts
import { rpc } from '$lib/rpc';

// Reactive read in a component
const audio = createQuery(() =>
  rpc.audio.getPlaybackUrl(() => recordingId).options,
);

// Reactive mutation observed in batch UI
const transcribeRecordings = createMutation(
  () => rpc.transcription.transcribeRecordings.options,
);
```

## Authoring rule

A module belongs here if it has the **adapter shape**:

- Wraps a single service call (or a tight composition of two).
- Side-effect-free at the work level: no toasts, sounds, analytics, pipelines, or settings writes. The only "effects" allowed are TanStack cache reads, writes, and invalidations.
- Adds a cache key (queries) and/or error transformation to `tagged error`.
- Useful to multiple observers, or earns its own module by participating in cache invalidation.

If your work has side effects beyond cache, it's an **orchestration** and belongs in `$lib/operations/`. Orchestrations are imperative use-case functions. Components that need `mutation.isPending` over an orchestration wrap it locally:

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

This isn't an exception to the rule: it's a direct consequence of it. Orchestrations aren't adapter-shaped, so they don't live here; observing their lifecycle is the component's concern, not the rpc layer's.

## Canonical module shape

Keep each adapter file in source-of-truth order:

```ts
const ExampleError = defineErrors({
  MissingThing: () => ({ message: 'Could not find the requested thing.' }),
});
type ExampleError = InferErrors<typeof ExampleError>;

type TransformThingInput = {
  id: string;
  input: string;
};

export const exampleKeys = defineKeys({
  all: ['example'],
  detail: (id: string) => ['example', 'detail', id] as const,
  transformThing: ['example', 'transformThing'],
});

export const example = {
  detail: (id: Accessor<string>) =>
    defineQuery({
      queryKey: exampleKeys.detail(id()),
      queryFn: () => services.example.detail(id()),
    }),

  transformThing: defineMutation({
    mutationKey: exampleKeys.transformThing,
    mutationFn: (params: TransformThingInput) =>
      services.example.transform(params),
  }),
};
```

Rules:

- Define keys with `defineKeys` and export the key map beside the adapter that owns it.
- Static key entries do not need `as const`; `defineKeys` preserves literal tuple types for them.
- Key factories need `as const` when the literal positions matter, like `['audio', 'playbackUrl', id] as const`.
- Keep keys in the owning module unless another layer must share the same fallback key, like web settings importing `autostartKeys` when Tauri is unavailable.
- Keep adapter-specific errors local unless another module needs to name that exact error union.
- Name input object types when a mutation takes a structured parameter. Inline the type only for single-use primitives.
- If you export the exact return shape of a `create*` factory, derive it with `ReturnType<typeof createThing>` instead of duplicating the object shape.

## Dependency direction

```
$lib/operations/  →  $lib/rpc/  →  $lib/services/ + $lib/state/
```

- `rpc/` may not import from `operations/`. If you find yourself wanting to, the work you're wrapping is probably an orchestration.
- A file in `rpc/` may import from `rpc/client` (the shared infra) but not from another sibling in `rpc/`. Cross-adapter coordination is an orchestration.

## Errors flow through unchanged

Services and operations return tagged errors built with `defineErrors` from `wellcrafted/error`. RPC adapters pass them through without translation; the component (or the operation it dispatches into) decides what the user should see by calling `report.error`, `report.info`, etc., from `$lib/report`.

```ts
transcribeRecording: defineMutation({
  mutationFn: async (recording: Recording) => {
    const { data: blob, error } = await services.blobs.audio.getBlob(recording.id);
    if (error) return Err(error); // tagged error from the service, unchanged
    return services.transcriptions.openai.transcribe(blob, options);
  },
});
```

## Imperative escape hatches

Every `defineQuery`/`defineMutation` returned object is also directly callable and exposes `.fetch()` / `.execute()` for imperative use. Prefer plain async functions in `$lib/operations/` for code that is not observed by a component, instead of reaching for `.execute()` on a mutation.

## Architecture context

```
UI (.svelte)
  │  createQuery(() => rpc.<x>.options)         ← shared cached reads
  │  createMutation(() => rpc.<y>.options)      ← shared mutations w/ cache invalidation
  │  createMutation(() => ({ mutationFn: ... }))← local lifecycle over an orchestration
  │  await <operation>(...)                     ← fire-and-forget orchestrations
  ▼
$lib/operations/*   imperative orchestrations (delivery, recording, upload,
                    pipeline, transcribe, transform, transformation-clipboard,
                    analytics, sound, shortcuts)
  ▼
$lib/rpc/*          TanStack adapters (this directory)
  ▼
$lib/services/*     pure, Result-typed
$lib/state/*        reactive (Svelte runes, Yjs)
```

See `$lib/services/README.md` for the service layer.
