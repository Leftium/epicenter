# State

Singleton reactive state that stays in sync with the application. Unlike the query layer which uses stale-while-revalidate caching, state modules maintain live state that updates immediately and persists across the application lifecycle.

## When to Use State vs Query Layer

| Aspect | `$lib/state/` | `$lib/query/` |
|--------|----------------|---------------|
| **Pattern** | Singleton reactive state | Stale-while-revalidate (TanStack Query) |
| **State Location** | Module-level `$state` runes | TanStack Query cache |
| **Updates** | Immediate, live | Cached with background refresh |
| **Use Case** | Hardware state, user preferences, live status | Data fetching, mutations, cached data |
| **Lifecycle** | Application lifetime | Managed by TanStack Query |

## Current State Modules

### `workspace-settings.svelte.ts`

Synced workspace settings backed by Yjs KV. Settings here roam across devices via CRDT sync. Uses a SvelteMap for per-key reactivity.

```typescript
import { workspaceSettings } from '$lib/state/workspace-settings.svelte';

// Read settings reactively (re-renders on change)
const mode = workspaceSettings.get('recording.mode');

// Update settings (writes to Yjs KV → syncs to other devices)
workspaceSettings.set('recording.mode', 'vad');
```

### `device-config.svelte.ts`

Device-bound configuration backed by per-key localStorage. Secrets, hardware IDs, filesystem paths, and global OS shortcuts that should never sync across devices. Uses a SvelteMap for per-key reactivity with cross-tab sync via storage events.

```typescript
import { deviceConfig } from '$lib/state/device-config.svelte';

// Read config reactively
const apiKey = deviceConfig.get('apiKeys.openai');

// Update config (writes to localStorage per-key)
deviceConfig.set('apiKeys.openai', 'sk-...');

// Get definition default (for "Default: X" placeholders)
const defaultShortcut = deviceConfig.getDefault('shortcuts.global.toggleManualRecording');
```

### `vad-recorder.svelte.ts`

Voice Activity Detection (VAD) recorder singleton. Manages the VAD hardware state and provides reactive access to detection status.

```typescript
import { vadRecorder } from '$lib/state/vad-recorder.svelte';

// Reactive state access (triggers $effect when changed)
$effect(() => {
  console.log('VAD state:', vadRecorder.state); // 'IDLE' | 'LISTENING' | 'SPEECH_DETECTED'
});

// Start/stop VAD
await vadRecorder.startActiveListening({
  onSpeechStart: () => console.log('Speaking...'),
  onSpeechEnd: (blob) => processAudio(blob),
});
await vadRecorder.stopActiveListening();
```

## Why VAD Lives Here

The VAD recorder doesn't fit the query layer pattern because:

1. **Live state**: VAD state (`IDLE` → `LISTENING` → `SPEECH_DETECTED`) must update immediately as hardware events occur
2. **Singleton nature**: Only one VAD instance can exist at a time
3. **Resource management**: Requires explicit cleanup (`stopActiveListening`) rather than cache invalidation
4. **Hardware lifecycle**: Tied to microphone access, not data fetching

## Adding New State Modules

Create a new state module when you need:

1. **Live reactive state** that must update immediately (not stale-while-revalidate)
2. **Singleton behavior** where only one instance should exist
3. **Application-lifetime persistence** (not request-scoped)
4. **Hardware or system state** that can't be "refreshed" like data

Use the query layer (`$lib/query/`) instead when you need:
- Data fetching with caching
- Mutations with optimistic updates
- Background refresh and stale-while-revalidate
- TanStack Query devtools integration

See `$lib/query/README.md` for the query layer documentation.
