import { Ok, type Result } from 'wellcrafted/result';
import type { AudioArtifact, RecorderError } from './types';

/**
 * Materialize an artifact as a `Blob`. Used at the boundary with code
 * paths that consume Blobs (history persistence, the legacy
 * navigator-shaped transcription dispatch).
 *
 * - `pcm` -> in-memory WAV synthesis (IEEE Float, mono). Cheap; bounded
 *   by recording length.
 * - `blob` -> identity.
 *
 * Returns `Result` for symmetry with code that branches on error, though
 * neither variant can actually fail today.
 */
export async function artifactToBlob(
	artifact: AudioArtifact,
): Promise<Result<Blob, RecorderError>> {
	if (artifact.kind === 'blob') return Ok(artifact.blob);
	const wavBuffer = encodePcmAsWav(artifact);
	return Ok(new Blob([wavBuffer], { type: 'audio/wav' }));
}

/**
 * Build a minimal IEEE Float 32-bit WAV file in memory from a mono PCM
 * artifact. Matches the format the previous Rust WAV writer produced,
 * so downstream decoders see one shape.
 */
function encodePcmAsWav(artifact: {
	samples: Float32Array;
	rate: number;
	channels: number;
}): ArrayBuffer {
	const { samples, rate, channels } = artifact;
	const bitsPerSample = 32;
	const bytesPerSample = bitsPerSample / 8;
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

	return buf;
}

function writeAscii(view: DataView, offset: number, str: string): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
