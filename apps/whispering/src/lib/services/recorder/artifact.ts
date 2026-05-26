import { Ok, type Result } from 'wellcrafted/result';
import { RecorderError, type AudioArtifact } from './types';
import { requireTauri } from '$lib/tauri';

/**
 * Materialize an artifact as a `Blob`. Used at the boundary with code
 * paths that still consume Blobs (history persistence, the legacy
 * navigator-shaped transcription dispatch).
 *
 * - `pcm` -> in-memory WAV synthesis (IEEE Float, mono). Cheap; bounded
 *   by recording length.
 * - `file` -> read bytes from disk via the Tauri fs plugin.
 * - `blob` -> identity.
 */
export async function artifactToBlob(
	artifact: AudioArtifact,
): Promise<Result<Blob, RecorderError>> {
	if (artifact.kind === 'blob') return Ok(artifact.blob);
	if (artifact.kind === 'pcm') {
		const wavBuffer = encodePcmAsWav(artifact);
		return Ok(new Blob([wavBuffer], { type: 'audio/wav' }));
	}
	// kind === 'file'
	const { data: blob, error } = await requireTauri().fs.pathToBlob(
		artifact.path,
	);
	if (error) return RecorderError.ReadFileFailed({ cause: error });
	return Ok(blob);
}

/**
 * Build a minimal IEEE Float 32-bit WAV file in memory from a mono PCM
 * artifact. Matches the format the Rust progressive WAV writer produces,
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
