/** Captures identify the exact bytes observed or submitted, across every storage backend. */

/** A fixed path and SHA-256 of the bytes captured there. Holds no lease. */
export type FileCapture = {
	path: string;
	sha256: string;
};

/** A capture with detached bytes. */
export type CapturedFile = FileCapture & { bytes: Uint8Array };

/** A capture with the exact text decoded from its bytes. */
export type TextCapture = FileCapture & { source: string };

/** Detach a capture from its caller. Later saves return new captures. */
export function fileCapture(path: string, sha256: string): FileCapture {
	return Object.freeze({ path, sha256 });
}

/** Why a supplied value is not a usable capture, or undefined when it is. */
export function captureProblem(file: FileCapture): string | undefined {
	if (
		typeof (file as Partial<FileCapture> | null | undefined)?.path !== 'string'
	)
		return 'the capture has no path';
	const sha256 = (file as Partial<FileCapture> | null | undefined)?.sha256;
	if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))
		return 'the capture has no valid SHA-256';
	return undefined;
}

const encoder = new TextEncoder();

/** Own content before awaiting anything. Strings encode as UTF-8 without normalization. */
export function ownBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === 'string'
		? encoder.encode(content)
		: new Uint8Array(content);
}

/** Hash before starting storage transactions, which cannot await crypto. */
export async function hashBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	let hex = '';
	for (const byte of new Uint8Array(digest))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}
