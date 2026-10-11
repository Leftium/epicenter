/**
 * What kind of audio a capture actually produced.
 *
 * A new recording's audio is saved as `<id>.<extension>`, and the extension is
 * what players, Git tooling, and a transcription endpoint use to decide how to
 * read it. A recorder's reported MIME type is a claim; the container's own
 * signature is evidence. The signature decides when it is recognized, and the
 * claim is used only when it is not.
 */

export type AudioFormat = {
	/** One ASCII alphanumeric segment, used as the saved audio file's extension. */
	readonly extension: string;
	readonly mimeType: string;
};

const FORMATS = {
	wav: { extension: 'wav', mimeType: 'audio/wav' },
	webm: { extension: 'webm', mimeType: 'audio/webm' },
	m4a: { extension: 'm4a', mimeType: 'audio/mp4' },
	ogg: { extension: 'ogg', mimeType: 'audio/ogg' },
	mp3: { extension: 'mp3', mimeType: 'audio/mpeg' },
	flac: { extension: 'flac', mimeType: 'audio/flac' },
} as const satisfies Record<string, AudioFormat>;

const BY_EXTENSION: Record<string, AudioFormat> = {
	...FORMATS,
	mp4: { extension: 'mp4', mimeType: 'audio/mp4' },
	oga: { extension: 'oga', mimeType: 'audio/ogg' },
	opus: { extension: 'opus', mimeType: 'audio/ogg' },
	aac: { extension: 'aac', mimeType: 'audio/aac' },
};

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
	String.fromCharCode(...bytes.subarray(offset, offset + length));

/** The container named by the first bytes, or undefined when none is recognized. */
export function sniffAudioFormat(bytes: Uint8Array): AudioFormat | undefined {
	if (bytes.length < 12) return undefined;
	if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE')
		return FORMATS.wav;
	if (
		bytes[0] === 0x1a &&
		bytes[1] === 0x45 &&
		bytes[2] === 0xdf &&
		bytes[3] === 0xa3
	)
		return FORMATS.webm;
	if (ascii(bytes, 4, 4) === 'ftyp') return FORMATS.m4a;
	if (ascii(bytes, 0, 4) === 'OggS') return FORMATS.ogg;
	if (ascii(bytes, 0, 4) === 'fLaC') return FORMATS.flac;
	if (ascii(bytes, 0, 3) === 'ID3') return FORMATS.mp3;
	// An MPEG audio frame sync: eleven set bits, then a layer that is not reserved.
	if (
		bytes[0] === 0xff &&
		(bytes[1]! & 0xe0) === 0xe0 &&
		(bytes[1]! & 0x06) !== 0
	)
		return FORMATS.mp3;
	return undefined;
}

/** The format a recorder's MIME type claims, ignoring codec parameters. */
export function formatFromMimeType(mimeType: string): AudioFormat | undefined {
	const base = mimeType.split(';')[0]!.trim().toLowerCase();
	switch (base) {
		case 'audio/wav':
		case 'audio/wave':
		case 'audio/x-wav':
			return FORMATS.wav;
		case 'audio/webm':
		case 'video/webm':
			return FORMATS.webm;
		case 'audio/mp4':
		case 'audio/x-m4a':
		case 'video/mp4':
			return FORMATS.m4a;
		case 'audio/ogg':
			return FORMATS.ogg;
		case 'audio/mpeg':
		case 'audio/mp3':
			return FORMATS.mp3;
		case 'audio/flac':
			return FORMATS.flac;
		default:
			return undefined;
	}
}

/**
 * The format to save captured bytes under. Unrecognized bytes with an
 * unrecognized claim are still saved, as `.bin`, so no capture is dropped.
 */
export function resolveAudioFormat(
	bytes: Uint8Array,
	claimedMimeType: string,
): AudioFormat {
	return (
		sniffAudioFormat(bytes) ??
		formatFromMimeType(claimedMimeType) ?? {
			extension: 'bin',
			mimeType: 'application/octet-stream',
		}
	);
}

export function extensionOf(path: string): string {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The playback MIME type for a file in the folder, by its extension. */
export function audioMimeTypeOf(path: string): string | undefined {
	return BY_EXTENSION[extensionOf(path)]?.mimeType;
}

/** The play length of PCM WAV bytes, or undefined when they are not readable WAV. */
export function wavDurationMs(bytes: Uint8Array): number | undefined {
	if (sniffAudioFormat(bytes)?.extension !== 'wav') return undefined;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let byteRate: number | undefined;
	let offset = 12;
	while (offset + 8 <= bytes.length) {
		const id = ascii(bytes, offset, 4);
		const size = view.getUint32(offset + 4, true);
		if (id === 'fmt ' && offset + 20 <= bytes.length)
			byteRate = view.getUint32(offset + 16, true);
		if (id === 'data') {
			if (byteRate === undefined || byteRate === 0) return undefined;
			const length = Math.min(size, bytes.length - offset - 8);
			return Math.round((length / byteRate) * 1000);
		}
		offset += 8 + size + (size % 2);
	}
	return undefined;
}
