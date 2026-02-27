---
name: services-layer
description: Service layer patterns with createTaggedError, namespace exports, and Result types. Use when creating new services, defining domain-specific errors, or understanding the service architecture.
metadata:
  author: epicenter
  version: '1.0'
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

## Creating Tagged Errors with createTaggedError

Every service defines domain-specific errors using `createTaggedError` from wellcrafted. See the `create-tagged-error` skill for full API reference.

### Two Clean Modes

`.withMessage()` and call-site `message` are **mutually exclusive modes**, not a default-with-override:

```typescript
import { createTaggedError } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

// Mode 1: No .withMessage() — message REQUIRED at every call site
export const { MyServiceError, MyServiceErr } =
	createTaggedError('MyServiceError');
type MyServiceError = ReturnType<typeof MyServiceError>;

MyServiceErr({ message: 'Something specific went wrong' })
MyServiceErr({ message: `Failed to do X: ${extractErrorMessage(error)}` })

// Mode 2: With .withMessage() — message SEALED by template, not in input type
export const { RecorderBusyError, RecorderBusyErr } =
	createTaggedError('RecorderBusyError')
		.withMessage(() => 'A recording is already in progress');

RecorderBusyErr()  // message is always "A recording is already in progress"
```

### What createTaggedError Returns

`createTaggedError('Name')` returns a **builder**. You can use it directly (no `.withMessage()`) or chain `.withMessage(fn)` to seal the message:

1. **`NameError`** - Constructor function for creating error objects
2. **`NameErr`** - Helper that wraps the error in `Err()` for direct return

```typescript
// Without .withMessage() — message required:
return Err(MyServiceError({ message: 'Something failed' }));
return MyServiceErr({ message: 'Something failed' }); // Shorter form

// With .withMessage() — no message input:
return Err(RecorderBusyError());
return RecorderBusyErr(); // Shorter form
```

### Adding Typed Fields with .withFields()

For errors that need structured metadata, chain `.withFields<T>()`. Fields are flat on the error object (no nesting):

```typescript
export const { ResponseError, ResponseErr } =
	createTaggedError('ResponseError')
		.withFields<{ status: number }>()
		.withMessage(({ status }) => `HTTP ${status} response`);

// Usage: Provide fields, message auto-computes, sealed by template
return ResponseErr({ status: 401 });
// error.message → "HTTP 401 response"
// error.status  → 401 (flat on the object)
```

### Error Type Examples from the Codebase

```typescript
// Static message, sealed — no input needed at call site
export const { RecorderBusyError, RecorderBusyErr } = createTaggedError(
	'RecorderBusyError',
).withMessage(() => 'A recording is already in progress');
RecorderBusyErr()

// No .withMessage() — diverse messages, caller provides each time
export const { FsServiceError, FsServiceErr } =
	createTaggedError('FsServiceError');
FsServiceErr({ message: `Failed to read '${path}': ${extractErrorMessage(e)}` })

// Fields + sealed message — message computed from fields
export const { ResponseError, ResponseErr } = createTaggedError(
	'ResponseError',
)
	.withFields<{ status: number }>()
	.withMessage(({ status }) => `HTTP ${status} response`);
ResponseErr({ status: 404 })

// Multiple related errors forming a discriminated union
export const { ConnectionError, ConnectionErr } =
	createTaggedError('ConnectionError')
		.withMessage(() => 'Failed to connect to the server');
export const { ParseError, ParseErr } = createTaggedError('ParseError')
	.withMessage(() => 'Failed to parse response body');

// Combine into union type
export type HttpServiceError = ConnectionError | ResponseError | ParseError;
```

## Service Implementation Pattern

### Basic Service Structure

```typescript
import { createTaggedError, extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync, trySync } from 'wellcrafted/result';

// 1. Define domain-specific error type — no .withMessage() means
//    message is required at every call site (good for diverse messages)
export const { MyServiceError, MyServiceErr } =
	createTaggedError('MyServiceError');
type MyServiceError = ReturnType<typeof MyServiceError>;

// 2. Create factory function that returns service object
export function createMyService() {
	return {
		async doSomething(options: {
			param1: string;
			param2: number;
		}): Promise<Result<OutputType, MyServiceError>> {
			// Input validation
			if (!options.param1) {
				return MyServiceErr({ message: 'param1 is required' });
			}

			// Wrap risky operations with tryAsync
			const { data, error } = await tryAsync({
				try: () => riskyAsyncOperation(options),
				catch: (error) =>
					MyServiceErr({
						message: `Operation failed: ${extractErrorMessage(error)}`,
					}),
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

// RecorderServiceError has no .withMessage() — diverse messages at call sites
export const { RecorderServiceError, RecorderServiceErr } =
	createTaggedError('RecorderServiceError');

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
				return RecorderServiceErr({
					message:
						'A recording is already in progress. Please stop the current recording.',
				});
			}

			// Get stream (calls another service)
			const { data: streamResult, error: acquireStreamError } =
				await getRecordingStream({ selectedDeviceId, sendStatus });

			if (acquireStreamError) {
				return RecorderServiceErr({
					message: acquireStreamError.message,
				});
			}

			// Initialize MediaRecorder
			const { data: mediaRecorder, error: recorderError } = trySync({
				try: () =>
					new MediaRecorder(stream, {
						bitsPerSecond: Number(bitrateKbps) * 1000,
					}),
				catch: (error) =>
					RecorderServiceErr({
						message: `Failed to initialize recorder. ${extractErrorMessage(error)}`,
					}),
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
export function createTextServiceDesktop(): TextService {
	return {
		copyToClipboard: (text) =>
			tryAsync({
				try: () => writeText(text), // Tauri API
				catch: (error) =>
					TextServiceErr({
						message: `Clipboard write failed: ${extractErrorMessage(error)}`,
					}),
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
					TextServiceErr({
						message: `Clipboard write failed: ${extractErrorMessage(error)}`,
					}),
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

### Choosing the right mode

- **Use `.withMessage()`** when the message is static or fully computable from fields. The template seals the message — call sites can't override it.
- **Skip `.withMessage()`** when messages are diverse across call sites. Each call site provides `{ message }` directly.

```typescript
// Sealed message — same message every time, no call-site input
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
	.withMessage(() => 'A recording is already in progress');
RecorderBusyErr()

// Sealed message computed from fields — message varies but is predictable
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
	.withFields<{ status: number }>()
	.withMessage(({ status }) => `HTTP ${status} response`);
ResponseErr({ status: 404 })

// No .withMessage() — diverse messages at call sites
const { MyServiceError, MyServiceErr } = createTaggedError('MyServiceError');

return MyServiceErr({
	message: 'Unable to connect to the selected microphone. This could be because the device is already in use by another application, has been disconnected, or lacks proper permissions.',
});

return MyServiceErr({
	message: `Failed to parse configuration file. Please check that ${filename} contains valid JSON.`,
});

// Include technical details with extractErrorMessage
return MyServiceErr({
	message: `Database operation failed. ${extractErrorMessage(error)}`,
});
```

## Key Rules

1. **Services never import settings** - Pass configuration as parameters
2. **Services never import UI code** - No toasts, no notifications, no WhisperingError
3. **Always return Result types** - Never throw errors
4. **Use trySync/tryAsync** - See the error-handling skill for details
5. **Export factory + Live instance** - Factory for testing, Live for production
6. **Name errors consistently** - `{ServiceName}ServiceError` pattern

## References

- See `apps/whispering/src/lib/services/README.md` for architecture details
- See the `query-layer` skill for how services are consumed
- See the `error-handling` skill for trySync/tryAsync patterns
