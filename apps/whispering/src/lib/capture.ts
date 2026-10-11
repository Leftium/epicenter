/**
 * Audio capture for one recording at a time.
 *
 * The microphone device (`microphone.ts`) records with the WebView's
 * MediaRecorder. The fixture device exists for repeatable automation: it
 * returns the same bytes every time and marks the result `fixture`, so a
 * fixture take is never stored as a microphone take. The workspace decides
 * which device a session uses; nothing here falls back from one to the other.
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
	/**
	 * The microphone the person chose cannot be opened. Nothing was captured
	 * from any other microphone in its place.
	 */
	InputUnavailable: ({ label }: { label: string }) => ({
		message: `${label === '' ? 'The chosen microphone' : `“${label}”`} is not available, and no other microphone was used in its place. Connect it, or choose another input.`,
		label,
	}),
	/** The request was withdrawn before the microphone answered. Anything that answered late was released. */
	Cancelled: () => ({
		message: 'The microphone was not opened: the request was cancelled.',
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

/** A microphone the person chose by name. Kept on this device, never in the folder. */
export type MicrophonePreference = {
	/** The ID the WebView gave it. Capture asks for exactly this one. */
	readonly deviceId: string;
	/** Its name when it was chosen, shown when it is not connected. */
	readonly label: string;
};

export type MicrophoneListing = {
	/** Inputs that can be chosen by name. Empty until microphone access is allowed. */
	readonly devices: readonly MicrophonePreference[];
	/** Inputs exist but the WebView withholds their names until access is allowed. */
	readonly namesWithheld: boolean;
};

/** A live reading of one microphone that records, sends, and saves nothing. */
export type MicrophoneMeter = {
	/** The name of the microphone that is open. */
	readonly label: string;
	/** How loud the input is now, from 0 to 1. */
	level(): number;
	/** Release the microphone. */
	stop(): void;
};

/** The real inputs behind a capture device. A fixture device has none. */
export type MicrophoneInputs = {
	/**
	 * The inputs the WebView lists now. This never asks for access: without
	 * it the WebView lists nothing by name.
	 */
	list(): Promise<Result<MicrophoneListing, CaptureError>>;
	/**
	 * Ask for microphone access so inputs are listed by name. This opens the
	 * system default microphone and releases it at once; nothing is recorded.
	 */
	allow(signal?: AbortSignal): Promise<Result<undefined, CaptureError>>;
	/** Open `input`, or the system default, for a level reading only. */
	meter(
		input: MicrophonePreference | undefined,
		signal?: AbortSignal,
	): Promise<Result<MicrophoneMeter, CaptureError>>;
	/**
	 * Hear that inputs were connected or removed. Not every WebView says so,
	 * which is why listing again is always offered.
	 */
	onChange(listener: () => void): () => void;
};

export type CaptureStart = {
	/** The microphone to record from. Undefined is the system default. */
	readonly input?: MicrophonePreference;
	/** Withdraws the start. A microphone that opens afterward is released. */
	readonly signal?: AbortSignal;
};

export type CaptureDevice = {
	readonly source: CaptureSource;
	/** What the person is told this session records from. */
	readonly label: string;
	/** Undefined when this device has no real input to choose or test. */
	readonly inputs: MicrophoneInputs | undefined;
	start(options?: CaptureStart): Promise<Result<ActiveCapture, CaptureError>>;
};

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
		// No microphone is behind this device, so none is listed, asked for, or opened.
		inputs: undefined,
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
