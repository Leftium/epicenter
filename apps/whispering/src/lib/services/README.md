# Services Layer

The services layer provides pure, isolated business logic with no UI dependencies. Services handle platform differences (Desktop/Web) transparently and return consistent `Result<T, E>` types for error handling.

## How Services Are Consumed

Services are consumed through the rpc layer, which wraps them with caching, reactivity, and state management. Here's a real example showing how isolated, testable services are used:

```typescript
// From: /lib/rpc/transcription.ts
async function transcribeBlob(
	blob: Blob,
): Promise<Result<string, WhisperingError>> {
	const selectedService =
		settings.value['transcription.selectedTranscriptionService'];

	switch (selectedService) {
		case 'OpenAI':
			// Pure service call with explicit parameters
			return services.transcriptions.openai.transcribe(blob, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.openai'],
				modelName: settings.value['transcription.openai.model'],
			});
		case 'Groq':
			// Same interface, different implementation
			return services.transcriptions.groq.transcribe(blob, {
				outputLanguage: settings.value['transcription.outputLanguage'],
				prompt: settings.value['transcription.prompt'],
				temperature: settings.value['transcription.temperature'],
				apiKey: settings.value['apiKeys.groq'],
				modelName: settings.value['transcription.groq.model'],
			});
	}
}
```

**Notice how services are:**

- **Pure**: Accept explicit parameters, no hidden dependencies
- **Isolated**: No knowledge of UI state, settings, or reactive state
- **Testable**: Easy to unit test with mock parameters
- **Consistent**: All return `Result<T, E>` types for uniform error handling
- **Platform-agnostic**: Same interface works on desktop and web

The rpc layer injects configuration (like `settings.value`) and handles caching/reactivity, while services focus purely on business logic.

### Build-Time Platform Injection

Services handle **build-time dependency injection** for platform differences through filename suffixes resolved by Vite. The application produces different bundles for web and Tauri; each bundle only contains the implementations that target it.

```
services/text/
  index.browser.ts    Web implementation
  index.tauri.ts      Tauri implementation
  types.ts            Shared interface both impls satisfy
```

Consumers always write `import { TextServiceLive } from '$lib/services/text'`. They never name the platform. Vite's `resolve.extensions` picks `.browser.ts` for web builds and `.tauri.ts` for Tauri builds; the off-target file is never parsed or bundled.

```ts
// vite.config.ts (sketch)
const isTauri = process.env.TAURI_PLATFORM !== undefined;
export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.ts', '.json']
      : ['.browser.ts', '.ts', '.json'],
  },
});
```

Tauri-only capabilities don't live in `services/`. They live in a single file at `$lib/tauri.tauri.ts` with a `$lib/tauri.browser.ts` companion that exports a `null` namespace plus a throwing `requireTauri` stub. Consumers pick one of three call shapes depending on where they sit:

```ts
import { tauri } from '$lib/tauri';

// 1. Shared code (runs on web and Tauri): narrow once.
if (tauri) {
  await tauri.fs.pathToBlob(path);
  await tauri.ffmpeg.checkInstalled.ensure();
}

// 2. Shared helpers called only inside an `if (tauri)` block:
//    prop-drill the narrowed value.
function useTrayIcon(tauri: Tauri) {
  tauri.tray.setIcon({ icon: 'IDLE' });
}

// 3. Inside *.tauri.ts files (build system already gated): requireTauri.
import { requireTauri } from '$lib/tauri';
await requireTauri().fs.pathToBlob(audioPath);
```

See `docs/articles/20260526T012526-tauri-is-both-the-namespace-and-the-platform-check.md` for the full pattern walkthrough, and `specs/20260526T000140-collapse-tauri-only-services-into-namespace.md` for the original rationale.

> **💡 Three kinds of dependency injection**
>
> - **Build-time platform DI** (suffix files): for services that have a real implementation on both platforms. `text`, `notifications`, `os`, `sound`, `download`, `analytics`, `http`, `blob-store`, `recorder`. Each has `index.tauri.ts` + `index.browser.ts` + `types.ts`. Vite picks one at build time.
> - **Tauri-only namespace** (`$lib/tauri`): for capabilities that exist only on Tauri (fs, command, permissions, ffmpeg, tray, globalShortcuts, autostart). One file holds all of them. Consumers either narrow with `if (tauri)`, prop-drill the narrowed value into helpers, or call `requireTauri()` from inside a `.tauri.ts` file.
> - **Runtime DI** (switch on `settings.value`): for user-pick providers like `transcription` and `completion`.
>
> See `docs/articles/20260526T012650-two-switches-build-time-and-runtime.md` for the platform-vs-settings walkthrough.

## Core Concepts

### What Are Services?

Services are collections of pure functions that:

- Accept explicit parameters (no hidden dependencies)
- Return `Result<T, E>` types for consistent error handling
- Have no knowledge of UI state, settings, or reactive state
- Provide identical APIs across platforms (Desktop via Tauri, Web via browser APIs)

### Platform Detection

Vite picks the right file at build time based on `process.env.TAURI_PLATFORM`. Consumers import without naming the platform:

```typescript
// Resolves to services/text/index.browser.ts on web,
// services/text/index.tauri.ts on Tauri.
import { TextServiceLive } from '$lib/services/text';
```

### Result Types

All services use `Result<T, E>` for error handling:

```typescript
import { defineErrors, extractErrorMessage } from 'wellcrafted/error';
import { tryAsync, type Result } from 'wellcrafted/result';

const TranscriptionError = defineErrors({
	ApiFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to transcribe audio: ${extractErrorMessage(cause)}`,
		cause,
	}),
});

// Services return Results, not thrown errors
async function transcribe(
	blob: Blob,
): Promise<Result<string, TranscriptionError>> {
	return tryAsync({
		try: () => apiCall(blob),
		catch: (error) =>
			TranscriptionError.ApiFailed({ cause: error }),
	});
}
```

## Service-Specific Error Types

Each service defines its own errors using `defineErrors` from wellcrafted. Error types are part of the service's public API and contain all the context needed to understand what went wrong:

```typescript
import { defineErrors, type InferErrors, extractErrorMessage } from 'wellcrafted/error';

const DeviceStreamError = defineErrors({
  PermissionDenied: ({ cause }: { cause: unknown }) => ({
    message: `Microphone permission denied: ${extractErrorMessage(cause)}`,
    cause,
  }),
  DeviceConnectionFailed: ({ deviceId, cause }: { deviceId: string; cause: unknown }) => ({
    message: `Failed to connect to device '${deviceId}': ${extractErrorMessage(cause)}`,
    deviceId,
    cause,
  }),
});
type DeviceStreamError = InferErrors<typeof DeviceStreamError>;
```

### Error Handling Architecture

The error handling follows a clear pattern across three layers:

1. **Service Layer**: Returns domain-specific errors via `defineErrors`
2. **RPC Layer**: Wraps service errors into `WhisperingError` objects
3. **UI Layer**: Displays `WhisperingError` objects in toasts without re-wrapping

This pattern ensures consistent error handling and avoids double-wrapping errors.

### Error Type Best Practices

1. **Use `defineErrors` namespaces**: Group related errors under a single namespace

   ```typescript
   const RecorderError = defineErrors({
     AlreadyRecording: () => ({
       message: 'A recording is already in progress. Please stop the current recording.',
     }),
     InitFailed: ({ cause }: { cause: unknown }) => ({
       message: `Failed to initialize recorder: ${extractErrorMessage(cause)}`,
       cause,
     }),
   });
   type RecorderError = InferErrors<typeof RecorderError>;
   ```

2. **Accept `cause: unknown`, extract inside constructor**: Error constructors accept the raw caught error and call `extractErrorMessage(cause)` inside the message template. Call sites stay clean with `{ cause: error }`.

   ```typescript
   // ✅ GOOD: cause: error at call site, extractErrorMessage in constructor
   catch: (error) => RecorderError.InitFailed({ cause: error })

   // ❌ BAD: extractErrorMessage at call site, string passed to constructor
   catch: (error) => RecorderError.InitFailed({ underlyingError: extractErrorMessage(error) })
   ```

3. **Map Platform Errors**: Transform platform-specific errors
   ```typescript
   return tryAsync({
   	try: () => navigator.mediaDevices.getUserMedia(constraints),
   	catch: (error) =>
   		DeviceStreamError.PermissionDenied({ cause: error }),
   });
   ```

### Important: Services Don't Know About UI

Services should **never** import or use `WhisperingError`. That transformation happens in the rpc layer:

```typescript
// ❌ WRONG - Service shouldn't know about WhisperingError
import { WhisperingError } from '$lib/result';

// ✅ CORRECT - Service uses its own error type
const MyError = defineErrors({
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `Operation failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type MyError = InferErrors<typeof MyError>;
```

The rpc layer is responsible for transforming service errors into `WhisperingError` for toast notifications. This separation ensures:

- Services remain pure and testable
- Error types can evolve independently
- UI concerns don't leak into business logic

### Real-World Example: Recording Service Errors

```typescript
const RecorderError = defineErrors({
	AlreadyRecording: () => ({
		message: 'A recording is already in progress. Please stop the current recording.',
	}),
	StreamAcquisition: ({ cause }: { cause: unknown }) => ({
		message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
		cause,
	}),
	InitFailed: ({ cause }: { cause: unknown }) => ({
		message: `Failed to initialize recorder: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
type RecorderError = InferErrors<typeof RecorderError>;

export function createManualRecorderService() {
	return {
		startRecording: async (
			recordingSettings,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderError>> => {
			if (activeRecording) {
				return RecorderError.AlreadyRecording();
			}

			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream(selectedDeviceId, sendStatus);

			if (acquireStreamError) {
				return RecorderError.StreamAcquisition({
					cause: acquireStreamError,
				});
			}

			// Continue with recording logic...
		},
	};
}
```

This example shows:

- `defineErrors` namespace with structured variants
- `cause: unknown` accepted in constructors, `extractErrorMessage` called inside
- Clean call sites passing raw errors as `{ cause: error }`
- Error mapping when consuming other services

### Anti-Pattern: Double Wrapping

Never wrap an already-wrapped error. The rpc layer handles the single transformation from service error to `WhisperingError`:

```typescript
// ❌ BAD: Service returns tagged error, query wraps it, then UI wraps again
if (error) {
	const whisperingError = WhisperingError({
		/* ... */
	});
	notify.error.execute({ ...whisperingError.error }); // Double wrapping!
}

// ✅ GOOD: Service returns tagged error, query wraps it, UI uses directly
if (error) {
	notify.error.execute(error); // Already a WhisperingError from rpc layer
}
```

## Service Patterns

### Pattern 1: Single Implementation

Services that work identically across platforms:

```typescript
// vad.ts - Same implementation for desktop and web
export function createVadService() {
	return {
		getVadState(): VadState {
			/* ... */
		},
		async startListening() {
			/* ... */
		},
		async stopListening() {
			/* ... */
		},
	};
}

export type VadService = ReturnType<typeof createVadService>;

export const VadServiceLive = createVadService();
```

### Pattern 2: Platform-Specific Implementation

Services that need different implementations for desktop vs web:

```typescript
// types.ts - Shared interface
export type ClipboardService = {
	setClipboardText(text: string): Promise<Result<void, ClipboardError>>;
	writeTextToCursor(text: string): Promise<Result<void, ClipboardError>>;
};

// desktop.ts - Tauri implementation
export function createClipboardServiceDesktop(): ClipboardService {
	return {
		setClipboardText(text) {
			/* Tauri clipboard API */
		},
		writeTextToCursor(text) {
			/* Desktop-specific implementation */
		},
	};
}

// web.ts - Browser implementation
export function createClipboardServiceWeb(): ClipboardService {
	return {
		setClipboardText(text) {
			/* Browser clipboard API */
		},
		writeTextToCursor(text) {
			/* Web-specific implementation */
		},
	};
}

// index.browser.ts - Web impl exports `ClipboardServiceLive` directly
// index.tauri.ts - Tauri impl exports `ClipboardServiceLive` directly
// (Vite picks whichever file matches the build target)
```

**When to use platform-specific pattern:**

- Identical API across platforms
- Different underlying implementations
- Exactly one implementation runs at runtime

**When to use single implementation:**

- Same code works on all platforms
- No platform-specific APIs needed

## Configuration Injection

Services are pure and accept configuration as parameters. We never import/use global variables like `settings.value`—that's for the rpc layer.

```typescript
// ✅ CORRECT - Pure service
export function createCompletionService() {
	return {
		async complete({ apiKey, prompt }) {
			const client = new OpenAI({ apiKey }); // Injected from rpc layer
			// ...
		},
	};
}

// Query layer injects settings
const result = await services.completion.openai.complete({
	apiKey: settings.value['apiKeys.openai'], // Query layer responsibility
	prompt,
});
```

## Available Services

### Cross-platform (`services/`)

- `recorder/navigator.ts` - MediaRecorder-based audio capture (browser + desktop fallback)
- `recorder/types.ts` - Shared `RecorderService` interface, error types, params
- `device-stream.ts` - `getRecordingStream` and `enumerateDevices` shared by recorder backends
- `local-shortcut-manager.ts` - In-window keyboard shortcuts
- `toast.ts` - In-app toast notifications (Sonner)
- `text/` - Clipboard operations
- `blob-store/` - Audio blob persistence (IndexedDB on web, fs on desktop)
- `analytics/`, `download/`, `http/`, `notifications/`, `os/`, `sound/` - Platform-specific implementations behind a unified interface

### Tauri-only capabilities (`$lib/tauri`)

All seven Tauri-only capabilities live inline in one file at `$lib/tauri.tauri.ts`. The companion `$lib/tauri.browser.ts` exports `tauri = null` plus a throwing `requireTauri` stub. Consumers access via `if (tauri) { tauri.<cap>.method() }`, by prop-drilling the narrowed value, or by calling `requireTauri()` from inside a `.tauri.ts` file.

- `tauri.fs` - Filesystem operations (pathToBlob, pathToFile, pathsToFiles)
- `tauri.command` - Shell command execution (execute, spawn)
- `tauri.permissions` - macOS accessibility/microphone permission flows
- `tauri.ffmpeg` - FFmpeg binary helper (checkInstalled, compressAudioBlob)
- `tauri.tray` - System tray icon (setIcon)
- `tauri.globalShortcuts` - OS-level shortcut registration (registerCommand, unregisterCommand, unregisterAll)
- `tauri.autostart` - Launch-at-login toggle (isEnabled, enable, disable)

Each leaf picks one canonical call form: TanStack-wrapped (via `defineQuery`/`defineMutation`) where caching, reactivity, or post-mutation invalidation matter; plain async functions where they don't. There is no separate `tauri.rpc` sub-namespace.

Pure accelerator parsing (validate-format, pressed-keys-to-accelerator, the `Accelerator` brand) doesn't need the Tauri runtime and lives in `$lib/utils/accelerator.ts`. The Tauri-side registration code consumes the same types.

The cpal recorder (`services/recorder/cpal.tauri.ts`) stays under `services/` because it's a sibling of `navigator.ts` and the recorder folder exposes both through its own suffix files. Platform-neutral FFmpeg constants live at `$lib/constants/ffmpeg.ts`.

### Multi-provider services

- `transcription/` - Speech-to-text (OpenAI, Groq, ElevenLabs, Speaches, local Whisper/Parakeet/Moonshine)
- `completion/` - LLM completions (OpenAI, Anthropic, Google, Groq)

Recording state itself is owned by `$lib/state/manual-recorder.svelte.ts` and `$lib/state/vad-recorder.svelte.ts`, not by services. Services are pure operations; state lives one level up.

## Quick Start

Add a new dual-impl service:

```typescript
// 1. services/my-service/types.ts - shared interface
export type MyService = {
	doSomething(input: string): Promise<Result<Output, MyError>>;
};

// 2. services/my-service/index.browser.ts - web impl
import type { MyService } from './types';
export type { MyError, MyService } from './types';
export const MyServiceLive = {
	doSomething: async (input) => {
		/* browser API call */
	},
} satisfies MyService;

// 3. services/my-service/index.tauri.ts - Tauri impl
import type { MyService } from './types';
export type { MyError, MyService } from './types';
export const MyServiceLive = {
	doSomething: async (input) => {
		/* Tauri API call */
	},
} satisfies MyService;

// 4. Add to main export at services/index.ts
import { MyServiceLive } from './my-service';
// ... include in the `services` object
```

Vite picks `.browser.ts` for web builds, `.tauri.ts` for Tauri builds. Consumers import `from '$lib/services/my-service'` without naming the platform.

## Services vs RPC Layer

| Aspect             | Services              | RPC Layer            |
| ------------------ | --------------------- | ---------------------- |
| **State**          | Stateless             | Stateful (cache)       |
| **Dependencies**   | Explicit parameters   | Settings, state        |
| **Error Handling** | Result types          | Result + UI toasts     |
| **Usage**          | Direct function calls | TanStack Query         |
| **Reactivity**     | None                  | Reactive subscriptions |

Services provide pure business logic. The rpc layer adds caching, reactivity, and UI integration.
