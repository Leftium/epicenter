/**
 * A minimal web audio recorder: open the mic, capture to memory, and hand back
 * one {@link Blob} on stop. The whole capability dictation needs, nothing more
 * (no levels, no pause/resume, no device picker).
 *
 * Deliberately not a shared `@epicenter/recorder` package and deliberately not
 * imported from Whispering. Vocab is the only consumer today, and Whispering's
 * recorder is an app, not a capability; importing it would couple to the app, not
 * the capability. When a second app wants recording, extract it then, the same
 * call the spec made for the transcribe client.
 *
 * Result-typed and never-throwing: a denied mic or a capture fault comes back as
 * a {@link RecorderError}, which the caller surfaces at its toast layer.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

export const RecorderError = defineErrors({
	/** The mic could not be opened: permission denied, no device, or an insecure context. */
	MicUnavailable: ({ cause }: { cause: unknown }) => ({
		message: `Could not open the microphone: ${extractErrorMessage(cause)}`,
		cause,
	}),
	/** `stop()` was called with no recording in flight. */
	NotRecording: () => ({ message: 'No recording is in progress.' }),
	/** The recorder faulted mid-capture. */
	CaptureFailed: ({ cause }: { cause: unknown }) => ({
		message: `Recording failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type RecorderError = InferErrors<typeof RecorderError>;

export function createRecorder() {
	let isRecording = $state(false);
	let recorder: MediaRecorder | null = null;
	let stream: MediaStream | null = null;
	let chunks: Blob[] = [];

	/** Release the mic and drop the in-flight handles. */
	function teardown() {
		stream?.getTracks().forEach((track) => track.stop());
		stream = null;
		recorder = null;
		chunks = [];
		isRecording = false;
	}

	return {
		get isRecording() {
			return isRecording;
		},

		/** Open the mic and start capturing. A second call while recording is a no-op. */
		async start(): Promise<Result<void, RecorderError>> {
			if (isRecording) return Ok(undefined);

			// A missing `navigator.mediaDevices` (insecure context) throws inside the
			// thunk, so the one catch covers both denial and absence.
			const { data: micStream, error } = await tryAsync({
				try: () => navigator.mediaDevices.getUserMedia({ audio: true }),
				catch: (cause) => RecorderError.MicUnavailable({ cause }),
			});
			if (error) return Err(error);

			stream = micStream;
			chunks = [];
			// No mime type forced: the browser picks one it can encode (webm/opus on
			// Chrome, mp4 on Safari), and the transcribe client maps that mime to the
			// upload extension the wire detects the format from.
			recorder = new MediaRecorder(micStream);
			recorder.ondataavailable = (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			};
			recorder.start();
			isRecording = true;
			return Ok(undefined);
		},

		/** Stop capturing, release the mic, and resolve with the recorded audio. */
		stop(): Promise<Result<Blob, RecorderError>> {
			return new Promise((resolve) => {
				const active = recorder;
				if (!active || !isRecording) {
					resolve(RecorderError.NotRecording());
					return;
				}
				active.onstop = () => {
					const blob = new Blob(chunks, { type: active.mimeType });
					teardown();
					resolve(Ok(blob));
				};
				active.onerror = (event) => {
					teardown();
					resolve(RecorderError.CaptureFailed({ cause: event }));
				};
				active.stop();
			});
		},
	};
}
