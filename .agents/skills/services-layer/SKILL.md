---
name: services-layer
description: Service layer patterns with defineErrors, namespace exports, and Result types. Use when creating new services, defining domain-specific errors, or understanding the service architecture.
metadata:
  author: epicenter
  version: '2.0'
---

# Services Layer Patterns

This skill documents how to implement services in the Whispering architecture. Services are pure, isolated business logic with no UI dependencies that return `Result<T, E>` types for error handling.

## When to Apply This Skill

Use this pattern when you need to:

- Create a new service with domain-specific error handling
- Add error types with structured context (like HTTP status codes)
- Understand how services are organized and exported
- Implement platform-specific service variants (desktop vs web)

## Core Architecture

Services follow a three-layer architecture: **Service** → **Query** → **UI**

```
┌─────────────┐     ┌─────────────┐     ┌──────────────┐
│     UI      │ --> │  RPC/Query  │ --> │   Services   │
│ Components  │     │    Layer    │     │    (Pure)    │
└─────────────┘     └─────────────┘     └──────────────┘
```

**Services are:**

- **Pure**: Accept explicit parameters, no hidden dependencies
- **Isolated**: No knowledge of UI state, settings, or reactive stores
- **Testable**: Easy to unit test with mock parameters
- **Consistent**: All return `Result<T, E>` types for uniform error handling

## Creating Errors with defineErrors

Every service defines domain-specific errors using `defineErrors` from wellcrafted. Errors are grouped into a namespace object where each key becomes a variant.

```typescript
import { defineErrors, type InferError, type InferErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

// Namespace-style error definition
const MyServiceError = defineErrors({
  NotFound: ({ id }: { id: string }) => ({
    message: `Resource '${id}' not found`,
    id,
  }),
  InvalidInput: ({ field, reason }: { field: string; reason: string }) => ({
    message: `Invalid input for '${field}': ${reason}`,
    field,
    reason,
  }),
  Unexpected: ({ cause }: { cause: unknown }) => ({
    message: `Unexpected error: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

// Type derivation — shadow the const with a type of the same name
type MyServiceError = InferErrors<typeof MyServiceError>;
type NotFoundError = InferError<typeof MyServiceError.NotFound>;

// Call sites — each variant returns Err<...> directly
return MyServiceError.NotFound({ id: '123' });
return MyServiceError.InvalidInput({ field: 'email', reason: 'must contain @' });
return MyServiceError.Unexpected({ cause: error });
```

### How defineErrors Works

`defineErrors({ ... })` takes an object of factory functions and returns a namespace object. Each key becomes a variant:

- **`name` is auto-stamped** from the key (e.g., key `NotFound` → `error.name === 'NotFound'`)
- **The factory function IS the message generator** — it returns `{ message, ...fields }`
- **Each variant returns `Err<...>` directly** — no separate `FooErr` constructor needed
- **Types use `InferError` / `InferErrors`** — not `ReturnType`

```typescript
// No-input variant (static message)
const RecorderError = defineErrors({
  Busy: () => ({
    message: 'A recording is already in progress',
  }),
});

// Usage — no arguments needed
return RecorderError.Busy();

// Variant with derived fields — constructor extracts from raw input
const HttpError = defineErrors({
  Response: ({ response, body }: { response: { status: number }; body: unknown }) => ({
    message: `HTTP ${response.status}: ${extractErrorMessage(body)}`,
    status: response.status,
    body,
  }),
});

// Usage — pass raw objects, constructor derives fields
return HttpError.Response({ response, body: await response.json() });
// error.message → "HTTP 401: Unauthorized"
// error.status  → 401 (derived from response, flat on the object)
// error.name    → "Response"
```

### Error Type Examples from the Codebase

```typescript
// Static message, no input needed
const RecorderError = defineErrors({
  Busy: () => ({
    message: 'A recording is already in progress',
  }),
});
RecorderError.Busy()

// Multiple related errors in a single namespace
const HttpError = defineErrors({
  Connection: ({ cause }: { cause: unknown }) => ({
    message: `Failed to connect to the server: ${extractErrorMessage(cause)}`,
    cause,
  }),
  Response: ({ response, body }: { response: { status: number }; body: unknown }) => ({
    message: `HTTP ${response.status}: ${extractErrorMessage(body)}`,
    status: response.status,
    body,
  }),
  Parse: ({ cause }: { cause: unknown }) => ({
    message: `Failed to parse response body: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

// Union type for the whole namespace
type HttpError = InferErrors<typeof HttpError>;

// Individual variant type
type ConnectionError = InferError<typeof HttpError.Connection>;
```

## Anti-Pattern: Discriminated Union Inputs

**String literal unions inside error factory inputs are a code smell.** When a variant's input contains a field like `reason: 'a' | 'b' | 'c'` or `operation: 'x' | 'y' | 'z'`, you're creating a sub-discriminant that duplicates what `defineErrors` already provides at the top level.

### The Problem

```typescript
// BAD: Sub-discriminant forces double narrowing and dishonest types
const ShortcutError = defineErrors({
  InvalidAccelerator: (input: {
    reason: 'invalid_format' | 'no_key_code' | 'multiple_key_codes';
    accelerator?: string;  // Optional because some reasons don't use it
  }) => {
    const messages = {
      invalid_format: `Invalid format: '${input.accelerator}'`,
      no_key_code: 'No valid key code found',
      multiple_key_codes: 'Multiple key codes not allowed',
    };
    return { message: messages[input.reason], ...input };
  },
});
```

**Why this is bad:**
1. **Double narrowing**: Consumers must narrow on `error.name` then on `error.reason`
2. **Dishonest types**: `accelerator` is optional because some reasons don't need it, but the type doesn't express which ones do
3. **Obscured intent**: The `reason` field is doing the discriminant's job — that's what variant names are for

### The Fix: Split Into Separate Variants

```typescript
// GOOD: Each variant has exactly the fields it needs
const ShortcutError = defineErrors({
  InvalidFormat: ({ accelerator }: { accelerator: string }) => ({
    message: `Invalid accelerator format: '${accelerator}'`,
    accelerator,
  }),
  NoKeyCode: () => ({
    message: 'No valid key code found in pressed keys',
  }),
  MultipleKeyCodes: () => ({
    message: 'Multiple key codes not allowed in accelerator',
  }),
});
```

**Why this is better:**
- **Single narrowing**: `error.name === 'NoKeyCode'` — done
- **Honest types**: `InvalidFormat` requires `accelerator`, `NoKeyCode` takes nothing
- **Self-documenting**: Variant names describe the error, no lookup table needed

### When This Applies

Split whenever you see:
- `reason: 'a' | 'b' | 'c'` with a message lookup table
- `operation: 'x' | 'y' | 'z'` with different messages per operation
- `errorKind: ...` or `type: ...` acting as a sub-discriminant
- Optional fields that exist because "some variants" don't use them

The whole point of `defineErrors` is that each variant is a first-class citizen with its own name and shape. Collapsing them behind string unions saves a few lines of definition at the cost of weaker types and double-narrowing at every consumer.

### Exception: When It's Genuinely One Error

If the string literal truly is a *field* and not a sub-discriminant — e.g., the consumer doesn't switch on it — then it's fine:

```typescript
// OK: 'operation' is metadata for logging, not a sub-discriminant
const FsError = defineErrors({
  ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to read '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
  WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
    message: `Failed to write '${path}': ${extractErrorMessage(cause)}`,
    path,
    cause,
  }),
});
```

## Service Implementation Pattern

### Basic Service Structure

```typescript
import { defineErrors, type InferErrors, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

// 1. Define domain-specific errors as a namespace
const MyServiceError = defineErrors({
  InvalidParam: ({ param }: { param: string }) => ({
    message: `${param} is required`,
    param,
  }),
  OperationFailed: ({ cause }: { cause: unknown }) => ({
    message: `Operation failed: ${extractErrorMessage(cause)}`,
    cause,
  }),
});
type MyServiceError = InferErrors<typeof MyServiceError>;

// 2. Create factory function that returns service object
export function createMyService() {
	return {
		async doSomething(options: {
			param1: string;
			param2: number;
		}): Promise<Result<OutputType, MyServiceError>> {
			// Input validation
			if (!options.param1) {
				return MyServiceError.InvalidParam({ param: 'param1' });
			}

			// Wrap risky operations with tryAsync
			const { data, error } = await tryAsync({
				try: () => riskyAsyncOperation(options),
				catch: (error) =>
					MyServiceError.OperationFailed({ cause: error }),
			});

			if (error) return Err(error);
			return Ok(data);
		},
	};
}

// 3. Export the "Live" instance (production singleton)
export type MyService = ReturnType<typeof createMyService>;
export const MyServiceLive = createMyService();
```

### Real-World Example: Recorder Service

```typescript
// From apps/whispering/src/lib/services/isomorphic/recorder/navigator.ts

const RecorderServiceError = defineErrors({
  AlreadyRecording: () => ({
    message: 'A recording is already in progress. Please stop the current recording.',
  }),
  StreamAcquisitionFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to acquire recording stream: ${extractErrorMessage(cause)}`,
    cause,
  }),
  InitFailed: ({ cause }: { cause: unknown }) => ({
    message: `Failed to initialize recorder. ${extractErrorMessage(cause)}`,
    cause,
  }),
});
type RecorderServiceError = InferErrors<typeof RecorderServiceError>;

export function createNavigatorRecorderService(): RecorderService {
	let activeRecording: ActiveRecording | null = null;

	return {
		getRecorderState: async (): Promise<
			Result<WhisperingRecordingState, RecorderServiceError>
		> => {
			return Ok(activeRecording ? 'RECORDING' : 'IDLE');
		},

		startRecording: async (
			params: NavigatorRecordingParams,
			{ sendStatus },
		): Promise<Result<DeviceAcquisitionOutcome, RecorderServiceError>> => {
			// Validate state
			if (activeRecording) {
				return RecorderServiceError.AlreadyRecording();
			}

			// Get stream (calls another service)
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId, sendStatus });

			if (acquireStreamError) {
				return RecorderServiceError.StreamAcquisitionFailed({
					cause: acquireStreamError,
				});
			}

			// Initialize MediaRecorder
			const { data: mediaRecorder, error: recorderError } = trySync({
				try: () =>
					new MediaRecorder(stream, {
						bitsPerSecond: Number(bitrateKbps) * 1000,
					}),
				catch: (error) =>
					RecorderServiceError.InitFailed({ cause: error }),
			});

			if (recorderError) {
				cleanupRecordingStream(stream);
				return Err(recorderError);
			}

			// Store state and start
			activeRecording = {
				recordingId,
				stream,
				mediaRecorder,
				recordedChunks: [],
			};
			mediaRecorder.start(TIMESLICE_MS);

			return Ok(deviceOutcome);
		},
	};
}

export const NavigatorRecorderServiceLive = createNavigatorRecorderService();
```

## Namespace Exports Pattern

Services are organized hierarchically and re-exported as namespace objects:

### Folder Structure

```
services/
├── desktop/           # Desktop-only (Tauri)
│   ├── index.ts       # Re-exports as desktopServices
│   ├── command.ts
│   └── ffmpeg.ts
├── isomorphic/        # Cross-platform
│   ├── index.ts       # Re-exports as services
│   ├── transcription/
│   │   ├── index.ts   # Re-exports as transcriptions namespace
│   │   ├── cloud/
│   │   │   ├── openai.ts
│   │   │   └── groq.ts
│   │   └── local/
│   │       └── whispercpp.ts
│   └── completion/
│       ├── index.ts
│       └── openai.ts
├── types.ts
└── index.ts           # Main entry point
```

### Index File Pattern

```typescript
// services/isomorphic/transcription/index.ts
export { OpenaiTranscriptionServiceLive as openai } from './cloud/openai';
export { GroqTranscriptionServiceLive as groq } from './cloud/groq';
export { WhispercppTranscriptionServiceLive as whispercpp } from './local/whispercpp';

// services/isomorphic/index.ts
import * as transcriptions from './transcription';
import * as completions from './completion';

export const services = {
	db: DbServiceLive,
	sound: PlaySoundServiceLive,
	transcriptions, // Namespace import
	completions, // Namespace import
} as const;

// services/index.ts (main entry)
export { services } from './isomorphic';
export { desktopServices } from './desktop';
```

### Consuming Services

```typescript
// In query layer or anywhere
import { services, desktopServices } from '$lib/services';

// Access via namespace
await services.transcriptions.openai.transcribe(blob, options);
await services.transcriptions.groq.transcribe(blob, options);
await services.db.recordings.getAll();
await desktopServices.ffmpeg.compressAudioBlob(blob, options);
```

## Platform-Specific Services

For services that need different implementations per platform:

### Define Shared Interface

```typescript
// services/isomorphic/text/types.ts
export type TextService = {
	readFromClipboard(): Promise<Result<string | null, TextServiceError>>;
	copyToClipboard(text: string): Promise<Result<void, TextServiceError>>;
	writeToCursor(text: string): Promise<Result<void, TextServiceError>>;
};
```

### Implement Per Platform

```typescript
// services/isomorphic/text/desktop.ts
const TextServiceError = defineErrors({
  ClipboardWriteFailed: ({ cause }: { cause: unknown }) => ({
    message: `Clipboard write failed: ${extractErrorMessage(cause)}`,
    cause,
  }),
});

export function createTextServiceDesktop(): TextService {
	return {
		copyToClipboard: (text) =>
			tryAsync({
				try: () => writeText(text), // Tauri API
				catch: (error) =>
					TextServiceError.ClipboardWriteFailed({ cause: error }),
			}),
	};
}

// services/isomorphic/text/web.ts
export function createTextServiceWeb(): TextService {
	return {
		copyToClipboard: (text) =>
			tryAsync({
				try: () => navigator.clipboard.writeText(text), // Browser API
				catch: (error) =>
					TextServiceError.ClipboardWriteFailed({ cause: error }),
			}),
	};
}
```

### Build-Time Platform Detection

```typescript
// services/isomorphic/text/index.ts
export const TextServiceLive = window.__TAURI_INTERNALS__
	? createTextServiceDesktop()
	: createTextServiceWeb();
```

## Error Message Best Practices

Write error messages that are:

- **User-friendly**: Explain what happened in plain language
- **Actionable**: Suggest what the user can do
- **Detailed**: Include technical details for debugging

### Choosing the right approach

- **No-input variants** for static messages (e.g., `Busy: () => ({ message: '...' })`)
- **Field-based variants** when the message is computed from structured input
- **Separate variants** when different error conditions need different fields (see Anti-Pattern section above)

```typescript
const RecorderError = defineErrors({
  // Static message — no input needed
  Busy: () => ({
    message: 'A recording is already in progress',
  }),

  // Message computed from fields
  HttpResponse: ({ status }: { status: number }) => ({
    message: `HTTP ${status} response`,
    status,
  }),

  // Wrapping an unknown cause with context
  MicrophoneUnavailable: ({ cause }: { cause: unknown }) => ({
    message: `Unable to connect to the selected microphone: ${extractErrorMessage(cause)}`,
    cause,
  }),

  // User-actionable message with file context
  ConfigParseFailed: ({ filename, cause }: { filename: string; cause: unknown }) => ({
    message: `Failed to parse configuration file. Please check that ${filename} contains valid JSON. ${extractErrorMessage(cause)}`,
    filename,
    cause,
  }),
});
```

## Key Rules

1. **Services never import settings** - Pass configuration as parameters
2. **Services never import UI code** - No toasts, no notifications, no WhisperingError
3. **Always return Result types** - Never throw errors
4. **Use trySync/tryAsync** - See the error-handling skill for details
5. **Export factory + Live instance** - Factory for testing, Live for production
6. **Use defineErrors namespaces** - Group related errors under a single namespace
7. **Derive types with InferError/InferErrors** - Not `ReturnType`
8. **Split discriminated union inputs** - Each variant gets its own name and shape
9. **Transform cause in the constructor, not the call site** - Accept `cause: unknown` and call `extractErrorMessage(cause)` inside the factory's message template. Call sites pass the raw error: `{ cause: error }`. This centralizes message extraction where the message is composed and keeps call sites clean.

## References

- See `apps/whispering/src/lib/services/README.md` for architecture details
- See the `query-layer` skill for how services are consumed
- See the `error-handling` skill for trySync/tryAsync patterns
