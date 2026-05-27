/**
 * Type-level smoke tests for the boundary adapter.
 *
 * These assertions never run at value-level; they exist so a regression in
 * the `Wrap<F>` mapper or in `tauri-specta`'s output surfaces as a
 * `svelte-check` / `tsc` failure at the type level.
 *
 * If specta's emitted shape changes (e.g. the discriminator key moves), the
 * `Wrap<F>` mapper stops matching and these assertions force the issue.
 */

import type { Result } from 'wellcrafted/result';
import type {
	RecordingArtifact,
	TranscribeRequest,
	TranscriptionError,
} from './commands';
import { commands } from './commands';

// Helper: a no-op assertion that two types are equal. Triggers a TS error
// if they diverge.
type Expect<T extends true> = T;
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: false;

// stop_recording: fallible, returns the artifact struct.
type _StopRecording = Expect<
	Equal<
		ReturnType<typeof commands.stopRecording>,
		Promise<Result<RecordingArtifact, string>>
	>
>;

// transcribe_recording: fallible, returns transcript text with the typed
// error union.
type _TranscribeRecording = Expect<
	Equal<
		ReturnType<
			typeof commands.transcribeRecording extends (...args: infer A) => infer R
				? (...args: A) => R
				: never
		>,
		Promise<Result<string, TranscriptionError>>
	>
>;

// set_unload_policy: infallible (Rust `()`). Stays plain Promise; no Result wrap.
type _SetUnloadPolicy = Expect<
	Equal<ReturnType<typeof commands.setUnloadPolicy>, Promise<void>>
>;

// open_accessibility_settings: fallible, returns unit as null.
type _OpenAccessibilitySettings = Expect<
	Equal<
		ReturnType<typeof commands.openAccessibilitySettings>,
		Promise<Result<null, string>>
	>
>;

// encode_recording_for_upload: hand-rolled, raw bytes success path.
type _EncodeRecordingForUpload = Expect<
	Equal<
		ReturnType<typeof commands.encodeRecordingForUpload>,
		Promise<Result<ArrayBuffer, string>>
	>
>;

// TranscribeRequest is a discriminated union surfaced by specta from the
// `#[serde(tag = "engine")]` enum on the Rust side.
type _TranscribeRequestShape = Expect<
	Equal<
		TranscribeRequest extends infer T
			? T extends { engine: 'whispercpp' }
				? T
				: never
			: never,
		{
			engine: 'whispercpp';
			modelPath: string;
			language?: string | null;
			initialPrompt?: string | null;
		}
	>
>;
