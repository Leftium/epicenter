/**
 * Content identity for captured file bytes.
 *
 * A version is computed from the exact bytes an operation observed or intends
 * to publish. It is not a timestamp, generation counter, or storage key, so a
 * browser and a native folder assign the same version to the same bytes.
 */

/** SHA-256 plus byte length of one captured file. */
export type FileVersion = {
	readonly sha256: string;
	readonly size: number;
};

/**
 * A captured file: a literal path and the version of the bytes it held when
 * captured. A plain, frozen, serializable value. It holds no lease and never
 * changes: a later save returns a new capture.
 */
export type FileCapture = {
	readonly path: string;
	readonly version: FileVersion;
};

/** A capture together with the detached bytes that were read. */
export type CapturedFile = FileCapture & { readonly bytes: Uint8Array };

/** A fixed capture of `path` at `version`, detached from the caller's objects. */
export function fileCapture(path: string, version: FileVersion): FileCapture {
	return Object.freeze({
		path,
		version: Object.freeze({ sha256: version.sha256, size: version.size }),
	});
}

/** Why a supplied value is not a usable capture, or `undefined` when it is. */
export function captureProblem(file: FileCapture): string | undefined {
	const version = (file as Partial<FileCapture> | null | undefined)?.version;
	if (
		typeof (file as Partial<FileCapture> | null | undefined)?.path !== 'string'
	)
		return 'the capture has no path';
	if (
		typeof version !== 'object' ||
		version === null ||
		typeof version.sha256 !== 'string' ||
		typeof version.size !== 'number'
	)
		return 'the capture has no content version';
	return undefined;
}

/**
 * The condition a managed write checks at its publication point.
 *
 * - A `FileVersion` requires the current bytes to be exactly those bytes.
 * - `'absent'` requires no file at the path (exclusive creation).
 * - `'any'` is a deliberate overwrite, such as a shell redirection.
 */
export type FileExpectation = FileVersion | 'absent' | 'any';

const encoder = new TextEncoder();

/**
 * Own the caller's content before anything is awaited: the caller may reuse
 * its array, and the saved bytes must be the ones the capture is computed
 * from. `new Uint8Array(view)` copies; `slice` on a Node Buffer would alias.
 * A string is encoded as UTF-8 with nothing added.
 */
export function ownBytes(content: string | Uint8Array): Uint8Array {
	return typeof content === 'string'
		? encoder.encode(content)
		: new Uint8Array(content);
}

/** Hash bytes before any storage transaction starts; a transaction cannot await crypto. */
export async function captureVersion(bytes: Uint8Array): Promise<FileVersion> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		bytes as Uint8Array<ArrayBuffer>,
	);
	return Object.freeze({ sha256: toHex(digest), size: bytes.byteLength });
}

export function sameVersion(
	left: FileVersion | undefined,
	right: FileVersion | undefined,
): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.sha256 === right.sha256 && left.size === right.size;
}

/** Whether `current` (undefined when absent) satisfies `expected`. */
export function satisfies(
	current: FileVersion | undefined,
	expected: FileExpectation,
): boolean {
	if (expected === 'any') return true;
	if (expected === 'absent') return current === undefined;
	return sameVersion(current, expected);
}

function toHex(buffer: ArrayBuffer): string {
	let hex = '';
	for (const byte of new Uint8Array(buffer))
		hex += byte.toString(16).padStart(2, '0');
	return hex;
}
