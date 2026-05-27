import { RECORDER_OUTPUT_RATE } from '$lib/constants/audio';

/**
 * Materialize the recorder's in-memory PCM as a mono 16 kHz IEEE Float
 * WAV blob. Used at the boundary with code paths that consume Blobs
 * (history persistence, the navigator-shaped transcription dispatch).
 *
 * Mono 16 kHz is the recorder's contract (`RECORDER_OUTPUT_RATE`); both
 * are baked into the WAV header here. If the contract ever changes, this
 * grows back to taking rate/channels parameters.
 */
export function pcmToWavBlob(samples: Float32Array): Blob {
	const bitsPerSample = 32;
	const bytesPerSample = bitsPerSample / 8;
	const channels = 1;
	const rate = RECORDER_OUTPUT_RATE;
	const dataSize = samples.byteLength;
	const fileSize = 36 + dataSize;
	const buf = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buf);

	// RIFF header
	writeAscii(view, 0, 'RIFF');
	view.setUint32(4, fileSize, true);
	writeAscii(view, 8, 'WAVE');

	// fmt chunk
	writeAscii(view, 12, 'fmt ');
	view.setUint32(16, 16, true); // PCM subchunk1 size
	view.setUint16(20, 3, true); // IEEE Float
	view.setUint16(22, channels, true);
	view.setUint32(24, rate, true);
	view.setUint32(28, rate * channels * bytesPerSample, true); // byte rate
	view.setUint16(32, channels * bytesPerSample, true); // block align
	view.setUint16(34, bitsPerSample, true);

	// data chunk
	writeAscii(view, 36, 'data');
	view.setUint32(40, dataSize, true);

	// f32 LE samples
	const pcmBytes = new Uint8Array(buf, 44);
	pcmBytes.set(
		new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
	);

	return new Blob([buf], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
