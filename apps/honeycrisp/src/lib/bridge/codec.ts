/**
 * The folder bridge's value encoding: JSON with tags for the values JSON
 * cannot carry. Both sides use it, so a `Result` from the folder reaches the
 * page with its fields, its `undefined`s, and its bytes intact.
 *
 *   undefined  -> {"$t":"u"}
 *   Uint8Array -> {"$t":"b","v":"<base64>"}
 *   Map        -> {"$t":"m","v":[[k,v],...]}
 *   Error      -> {"$t":"e","name":..,"message":..}
 *
 * An object that itself has a `$t` key is wrapped as {"$t":"o","v":{...}} so
 * it cannot be mistaken for a tag.
 */

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < bytes.length; offset += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
	const binary = atob(text);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1)
		bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function encode(value: unknown): Json {
	if (value === undefined) return { $t: 'u' };
	if (value === null) return null;
	if (typeof value === 'boolean' || typeof value === 'string') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'bigint' || typeof value === 'symbol')
		return String(value);
	if (typeof value === 'function') return { $t: 'u' };
	if (value instanceof Uint8Array) return { $t: 'b', v: toBase64(value) };
	if (value instanceof Map)
		return {
			$t: 'm',
			v: [...value].map(([key, item]) => [encode(key), encode(item)]),
		};
	if (value instanceof Error)
		return { $t: 'e', name: value.name, message: value.message };
	if (Array.isArray(value)) return value.map(encode);
	const object: { [key: string]: Json } = {};
	for (const [key, item] of Object.entries(value as object))
		object[key] = encode(item);
	return Object.hasOwn(object, '$t') ? { $t: 'o', v: object } : object;
}

export function decode(value: unknown): unknown {
	if (value === null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(decode);
	const object = value as Record<string, unknown>;
	const plain = (source: Record<string, unknown>) => {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(source))
			result[key] = decode(item);
		return result;
	};
	switch (object.$t) {
		case undefined:
			return plain(object);
		case 'u':
			return undefined;
		case 'b':
			return fromBase64(String(object.v));
		case 'm':
			return new Map(
				(object.v as [unknown, unknown][]).map(([key, item]) => [
					decode(key),
					decode(item),
				]),
			);
		case 'e': {
			const error = new Error(String(object.message));
			error.name = String(object.name);
			return error;
		}
		case 'o':
			return plain(object.v as Record<string, unknown>);
		default:
			throw new Error(`Unknown bridge value tag: ${String(object.$t)}`);
	}
}
