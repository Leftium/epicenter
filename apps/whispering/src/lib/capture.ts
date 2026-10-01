/**
 * Audio capture for one recording at a time.
 *
 * The microphone device records with the WebView's MediaRecorder. The fixture
 * device exists for repeatable automation: it returns the same bytes every
 * time and marks the result `fixture`, so a fixture take is never stored as a
 * microphone take. The workspace decides which device a session uses; nothing
 * here falls back from one to the other.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { resolveAudioFormat, wavDurationMs } from './audio-format.js';
import type { CaptureSource } from './definition.js';

export const CaptureError = defineErrors({
	Unavailable: ({ reason }: { reason: string }) => ({
		message: `Recording is not available here: ${reason}`,
		reason,
	}),
	PermissionDenied: () => ({
		message:
			'Microphone access was denied. Allow it for Whispering in System Settings, under Privacy and Security, then try again.',
	}),
	Failed: ({ cause }: { cause: unknown }) => ({
		message: `The recording could not be captured: ${cause instanceof Error ? cause.message : String(cause)}`,
		cause,
	}),
	Empty: () => ({
		message: 'The recording contained no audio.',
	}),
});
export type CaptureError = InferErrors<typeof CaptureError>;

export type CapturedAudio = {
	readonly bytes: Uint8Array;
	readonly extension: string;
	readonly mimeType: string;
	readonly durationMs: number;
	readonly source: CaptureSource;
};

export type ActiveCapture = {
	/** `performance.now()` when capture began, for the elapsed-time display. */
	readonly startedAt: number;
	stop(): Promise<Result<CapturedAudio, CaptureError>>;
	/** Stop and discard. Nothing is returned or saved. */
	cancel(): void;
};

export type CaptureDevice = {
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	start(): Promise<Result<ActiveCapture, CaptureError>>;
};

/** Containers in preference order; the recorder's own default is the fallback. */
const PREFERRED_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

export function createMicrophoneDevice(): CaptureDevice {
	return {
		source: 'microphone',
		label: 'Microphone',
		async start() {
			if (
				typeof navigator === 'undefined' ||
				navigator.mediaDevices?.getUserMedia === undefined
			)
				return CaptureError.Unavailable({
					reason: 'this window has no microphone access',
				});
			if (typeof MediaRecorder === 'undefined')
				return CaptureError.Unavailable({
					reason: 'this window cannot encode audio',
				});
			let stream: MediaStream;
			try {
				stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch (cause) {
				if (
					cause instanceof DOMException &&
					(cause.name === 'NotAllowedError' || cause.name === 'SecurityError')
				)
					return CaptureError.PermissionDenied();
				if (cause instanceof DOMException && cause.name === 'NotFoundError')
					return CaptureError.Unavailable({
						reason: 'no microphone was found',
					});
				return CaptureError.Failed({ cause });
			}
			const release = () => {
				for (const track of stream.getTracks()) track.stop();
			};
			let recorder: MediaRecorder;
			try {
				const mimeType = PREFERRED_TYPES.find((type) =>
					MediaRecorder.isTypeSupported(type),
				);
				recorder = new MediaRecorder(
					stream,
					mimeType === undefined ? undefined : { mimeType },
				);
			} catch (cause) {
				release();
				return CaptureError.Failed({ cause });
			}
			const chunks: Blob[] = [];
			recorder.addEventListener('dataavailable', (event) => {
				if (event.data.size > 0) chunks.push(event.data);
			});
			const startedAt = performance.now();
			try {
				recorder.start();
			} catch (cause) {
				release();
				return CaptureError.Failed({ cause });
			}
			let settled = false;
			return Ok({
				startedAt,
				stop() {
					return new Promise<Result<CapturedAudio, CaptureError>>((resolve) => {
						if (settled) {
							resolve(CaptureError.Empty());
							return;
						}
						settled = true;
						const durationMs = Math.round(performance.now() - startedAt);
						recorder.addEventListener(
							'error',
							(event) => {
								release();
								resolve(CaptureError.Failed({ cause: event }));
							},
							{ once: true },
						);
						recorder.addEventListener(
							'stop',
							async () => {
								release();
								const blob = new Blob(chunks);
								if (blob.size === 0) {
									resolve(CaptureError.Empty());
									return;
								}
								const bytes = new Uint8Array(await blob.arrayBuffer());
								const format = resolveAudioFormat(bytes, recorder.mimeType);
								resolve(
									Ok({
										bytes,
										...format,
										durationMs,
										source: 'microphone',
									}),
								);
							},
							{ once: true },
						);
						try {
							recorder.stop();
						} catch (cause) {
							release();
							resolve(CaptureError.Failed({ cause }));
						}
					});
				},
				cancel() {
					if (settled) return;
					settled = true;
					try {
						recorder.stop();
					} catch {
						// Already inactive; the tracks are released either way.
					}
					release();
				},
			});
		},
	};
}

export type FixtureAudio = {
	readonly name: string;
	readonly bytes: Uint8Array;
};

/**
 * A device that answers every recording with the same fixture bytes. `load`
 * runs at stop, so a missing or unreadable fixture fails that recording
 * instead of the session.
 */
export function createFixtureDevice({
	name,
	load,
}: {
	name: string;
	load: () => Promise<FixtureAudio>;
}): CaptureDevice {
	return {
		source: 'fixture',
		label: `Fixture audio (${name})`,
		async start() {
			const startedAt = performance.now();
			let settled = false;
			return Ok({
				startedAt,
				async stop() {
					if (settled) return CaptureError.Empty();
					settled = true;
					let fixture: FixtureAudio;
					try {
						fixture = await load();
					} catch (cause) {
						return CaptureError.Failed({ cause });
					}
					if (fixture.bytes.byteLength === 0) return CaptureError.Empty();
					const format = resolveAudioFormat(fixture.bytes, '');
					return Ok({
						bytes: fixture.bytes,
						...format,
						// The fixture's own length when it can be read, not the wait before Stop.
						durationMs:
							wavDurationMs(fixture.bytes) ??
							Math.round(performance.now() - startedAt),
						source: 'fixture',
					});
				},
				cancel() {
					settled = true;
				},
			});
		},
	};
}

/** A one-second 440 Hz mono PCM WAV, for the browser development fixture. */
export function toneWav({
	seconds = 1,
	sampleRate = 16000,
	frequency = 440,
} = {}): Uint8Array {
	const samples = Math.round(seconds * sampleRate);
	const bytes = new Uint8Array(44 + samples * 2);
	const view = new DataView(bytes.buffer);
	const text = (offset: number, value: string) => {
		for (let index = 0; index < value.length; index++)
			view.setUint8(offset + index, value.charCodeAt(index));
	};
	text(0, 'RIFF');
	view.setUint32(4, 36 + samples * 2, true);
	text(8, 'WAVE');
	text(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	text(36, 'data');
	view.setUint32(40, samples * 2, true);
	for (let index = 0; index < samples; index++)
		view.setInt16(
			44 + index * 2,
			Math.round(
				Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 0x2000,
			),
			true,
		);
	return bytes;
}
