/**
 * The wire encoding the folder bridge uses in both directions.
 *
 * JSON cannot carry `undefined`, bytes, maps, or errors, and the folder API
 * uses all four: an entry's `issues: undefined` discriminates a valid row,
 * file reads and attachments are bytes, `readMany` answers with a map, and an
 * `Io` failure carries its cause. Each is written as a tagged object and read
 * back as the same kind of value, so a `Result` crosses the bridge unchanged.
 *
 * This module is plain TypeScript with no platform imports. The page and the
 * Bun folder host both load it.
 */

const TAG = '$t';

type Tagged =
	| { [TAG]: 'u' }
	| { [TAG]: 'b'; v: string }
	| { [TAG]: 'm'; v: [unknown, unknown][] }
	| { [TAG]: 's'; v: unknown[] }
	| { [TAG]: 'e'; name: string; message: string }
	| { [TAG]: 'o'; v: Record<string, unknown> };

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += CHUNK)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
	return btoa(binary);
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function encodeObject(value: object): Record<string, unknown> {
	const encoded: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) {
		if (typeof item === 'function') continue;
		encoded[key] = encode(item);
	}
	return encoded;
}

/** Turn a value into JSON-safe data. Functions are dropped; a Blob is a caller error. */
export function encode(value: unknown): unknown {
	if (value === undefined) return { [TAG]: 'u' } satisfies Tagged;
	if (value === null || typeof value !== 'object') {
		if (typeof value === 'bigint' || typeof value === 'symbol')
			throw new TypeError(`A ${typeof value} cannot cross the folder bridge`);
		return typeof value === 'function' ? undefined : value;
	}
	if (value instanceof Uint8Array)
		return { [TAG]: 'b', v: bytesToBase64(value) } satisfies Tagged;
	if (value instanceof ArrayBuffer)
		return {
			[TAG]: 'b',
			v: bytesToBase64(new Uint8Array(value)),
		} satisfies Tagged;
	if (typeof Blob !== 'undefined' && value instanceof Blob)
		throw new TypeError('Read a Blob into bytes before it crosses the bridge');
	if (Array.isArray(value)) return value.map(encode);
	if (value instanceof Map)
		return {
			[TAG]: 'm',
			v: [...value].map(([key, item]): [unknown, unknown] => [
				encode(key),
				encode(item),
			]),
		} satisfies Tagged;
	if (value instanceof Set)
		return { [TAG]: 's', v: [...value].map(encode) } satisfies Tagged;
	if (value instanceof Error)
		return {
			[TAG]: 'e',
			name: value.name,
			message: value.message,
		} satisfies Tagged;
	const encoded = encodeObject(value);
	// A data object that happens to use the tag key is wrapped, never misread.
	return Object.hasOwn(value, TAG)
		? ({ [TAG]: 'o', v: encoded } satisfies Tagged)
		: encoded;
}

function decodeObject(value: Record<string, unknown>): Record<string, unknown> {
	const decoded: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value)) decoded[key] = decode(item);
	return decoded;
}

export function decode(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(decode);
	const record = value as Record<string, unknown>;
	if (!Object.hasOwn(record, TAG)) return decodeObject(record);
	const tagged = record as Tagged;
	switch (tagged[TAG]) {
		case 'u':
			return undefined;
		case 'b':
			return base64ToBytes(tagged.v);
		case 'm':
			return new Map(
				tagged.v.map(([key, item]) => [decode(key), decode(item)]),
			);
		case 's':
			return new Set(tagged.v.map(decode));
		case 'e': {
			const error = new Error(tagged.message);
			error.name = tagged.name;
			return error;
		}
		case 'o':
			return decodeObject(tagged.v);
		default:
			throw new TypeError('The folder bridge received an unknown value tag');
	}
}
