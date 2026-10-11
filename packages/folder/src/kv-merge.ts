/**
 * Three-way reconciliation of root KV values, independent of schema and Git.
 * Objects and arrays are atomic merge units. Selected value text survives;
 * root framing and key order are regenerated deterministically.
 *
 * This module owns `kv.json` text: `readKvMembers` decides what a valid file
 * is and `formatKvMembers` writes one, for a merge and for `kv.set` alike, so
 * a local save and a merge produce the same file.
 */
import { type Node, parseTree } from 'jsonc-parser';

export type KvMergeInput = {
	/** null means no file; an empty string is a present, invalid file. */
	base: string | null;
	ours: string | null;
	theirs: string | null;
};

export type KvMerge =
	| {
			kind: 'merged';
			/** The complete merged `kv.json` text, or null for no file. */
			text: string | null;
	  }
	| {
			kind: 'conflict';
			conflicts: readonly {
				key: string;
				/** Raw JSON value text, or null for an absent key. */
				base: string | null;
				ours: string | null;
				theirs: string | null;
			}[];
	  }
	| { kind: 'file-conflict' }
	| { kind: 'invalid'; side: keyof KvMergeInput };

type Value =
	| { kind: 'literal'; text: string }
	| { kind: 'string'; text: string }
	| { kind: 'array'; items: readonly Value[] }
	| { kind: 'object'; members: ReadonlyMap<string, Value> };
type Member = { raw: string; value: Value };

// vocab-check: ignore-next-line (Unicode scalar value is the Unicode standard term)
/** Unicode scalar order matches Rust's UTF-8 string ordering. */
function compareText(left: string, right: string) {
	const a = [...left];
	const b = [...right];
	for (let i = 0; i < a.length && i < b.length; i++) {
		const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
		if (difference !== 0) return difference;
	}
	return a.length - b.length;
}

function validUnicode(text: string) {
	for (const character of text) {
		const point = character.codePointAt(0)!;
		if (point >= 0xd800 && point <= 0xdfff) return false;
	}
	return true;
}

/** Bound recursive parsers before entering them; strings do not add depth. */
function withinDepth(source: string) {
	const closing: string[] = [];
	let quoted = false;
	let escaped = false;
	for (const character of source) {
		if (quoted) {
			if (character < ' ') return false;
			if (escaped) escaped = false;
			else if (character === '\\') escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') quoted = true;
		else if (character === '{' || character === '[') {
			closing.push(character === '{' ? '}' : ']');
			if (closing.length > 64) return false;
		} else if (character === '}' || character === ']') {
			if (closing.pop() !== character) return false;
		} else if (character === '/') return false;
	}
	return !quoted && closing.length === 0;
}

function readValue(node: Node, source: string): Value | undefined {
	switch (node.type) {
		case 'string': {
			const text: unknown = node.value;
			return typeof text === 'string' && validUnicode(text)
				? { kind: 'string', text }
				: undefined;
		}
		case 'number':
		case 'boolean':
		case 'null':
			return {
				kind: 'literal',
				text: source.slice(node.offset, node.offset + node.length),
			};
		case 'array': {
			const items: Value[] = [];
			for (const child of node.children ?? []) {
				const value = readValue(child, source);
				if (value === undefined) return undefined;
				items.push(value);
			}
			return { kind: 'array', items };
		}
		case 'object': {
			const members = new Map<string, Value>();
			for (const property of node.children ?? []) {
				const [name, child] = property.children ?? [];
				const key: unknown = name?.value;
				if (
					typeof key !== 'string' ||
					!validUnicode(key) ||
					members.has(key) ||
					child === undefined
				)
					return undefined;
				const value = readValue(child, source);
				if (value === undefined) return undefined;
				members.set(key, value);
			}
			return { kind: 'object', members };
		}
		default:
			return undefined;
	}
}

function read(source: string | null) {
	if (source === null) return null;
	if (!validUnicode(source) || !withinDepth(source)) return undefined;
	const text = source.startsWith('\uFEFF') ? source.slice(1) : source;
	const errors: Parameters<typeof parseTree>[1] = [];
	let root: Node | undefined;
	try {
		root = parseTree(text, errors, {
			disallowComments: true,
			allowTrailingComma: false,
			allowEmptyContent: false,
		});
	} catch (cause) {
		// Parser recovery must never turn malformed input into a stack overflow.
		if (cause instanceof RangeError) return undefined;
		throw cause;
	}
	if (errors.length !== 0 || root?.type !== 'object') return undefined;
	const members = new Map<string, Member>();
	for (const property of root.children ?? []) {
		const [name, child] = property.children ?? [];
		const key: unknown = name?.value;
		if (
			typeof key !== 'string' ||
			!validUnicode(key) ||
			members.has(key) ||
			child === undefined
		)
			return undefined;
		const value = readValue(child, text);
		if (value === undefined) return undefined;
		members.set(key, {
			raw: text.slice(child.offset, child.offset + child.length),
			value,
		});
	}
	return members;
}

function equal(left: Value | undefined, right: Value | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	if (left.kind !== right.kind) return false;
	switch (left.kind) {
		case 'literal':
		case 'string':
			return right.kind === left.kind && left.text === right.text;
		case 'array':
			return (
				right.kind === 'array' &&
				left.items.length === right.items.length &&
				left.items.every((item, i) => equal(item, right.items[i]))
			);
		case 'object':
			return (
				right.kind === 'object' &&
				left.members.size === right.members.size &&
				[...left.members].every(([key, value]) =>
					equal(value, right.members.get(key)),
				)
			);
	}
}

function sameFile(
	left: ReadonlyMap<string, Member>,
	right: ReadonlyMap<string, Member>,
) {
	return (
		left.size === right.size &&
		[...left].every(([key, member]) =>
			equal(member.value, right.get(key)?.value),
		)
	);
}

/**
 * Prepare a complete KV merge without reading or publishing any file.
 * Strings ignore escape spelling, objects ignore key order, and numbers use
 * exact tokens: 1 and 1.0 differ rather than risking rounding unknown values.
 * Invalid sources include duplicate keys, unpaired surrogates, and nesting
 * beyond 64 containers. All present sources are checked before merging.
 */
export function mergeKv(input: KvMergeInput): KvMerge {
	return reconcileKv(input, new Map());
}

/**
 * Settled root keys: each key's raw JSON value text, or `null` to leave the
 * key out. Every text must already be one value a folder can store.
 */
export type KvResolutions = ReadonlyMap<string, string | null>;

/**
 * `mergeKv`, with competing keys settled by `resolutions`. A resolution
 * applies only to a key that competes; every other key merges as usual, so
 * an independent change on either side survives. A competing key with no
 * resolution still conflicts.
 */
export function reconcileKv(
	{ base, ours, theirs }: KvMergeInput,
	resolutions: KvResolutions,
): KvMerge {
	const b = read(base);
	const o = read(ours);
	const t = read(theirs);
	if (b === undefined) return { kind: 'invalid', side: 'base' };
	if (o === undefined) return { kind: 'invalid', side: 'ours' };
	if (t === undefined) return { kind: 'invalid', side: 'theirs' };
	if (o === null || t === null) {
		const present = o ?? t;
		if (present === null) return { kind: 'merged', text: null };
		if (b !== null)
			return sameFile(b, present)
				? { kind: 'merged', text: null }
				: { kind: 'file-conflict' };
	}

	const keys = [
		...new Set([
			...(b?.keys() ?? []),
			...(o?.keys() ?? []),
			...(t?.keys() ?? []),
		]),
	].sort(compareText);
	const conflicts: Extract<
		KvMerge,
		{ kind: 'conflict' }
	>['conflicts'][number][] = [];
	const members: [string, string][] = [];
	for (const key of keys) {
		const before = b?.get(key);
		const left = o?.get(key);
		const right = t?.get(key);
		let selected: Member | undefined;
		if (equal(left?.value, right?.value)) {
			selected =
				left && right
					? compareText(left.raw, right.raw) <= 0
						? left
						: right
					: (left ?? right);
		} else if (equal(left?.value, before?.value)) selected = right;
		else if (equal(right?.value, before?.value)) selected = left;
		else if (resolutions.has(key)) {
			const settled = resolutions.get(key) ?? null;
			if (settled !== null) members.push([key, settled]);
			continue;
		} else {
			conflicts.push({
				key,
				base: before?.raw ?? null,
				ours: left?.raw ?? null,
				theirs: right?.raw ?? null,
			});
			continue;
		}
		if (selected) members.push([key, selected.raw]);
	}
	if (conflicts.length !== 0) return { kind: 'conflict', conflicts };
	return {
		kind: 'merged',
		text: formatKvMembers(members),
	};
}

/**
 * The root members of `kv.json` source, each as its exact raw value text, or
 * `undefined` when the source is not a file a folder can hold: strict JSON,
 * one object, no duplicate keys or unpaired surrogates, and nesting within 64
 * containers. A byte order mark is ignored.
 */
export function readKvMembers(
	source: string,
): ReadonlyMap<string, string> | undefined {
	const members = read(source);
	if (members === undefined || members === null) return undefined;
	return new Map([...members].map(([key, member]) => [key, member.raw]));
}

/**
 // vocab-check: ignore-next-line (Unicode scalar value is the Unicode standard term)
 * The `kv.json` text of root members: keys in Unicode scalar order, two-space
 * indentation, and each value's raw text as given. Every value must already
 * be one JSON value a folder can store.
 */
export function formatKvMembers(
	members: Iterable<readonly [string, string]>,
): string {
	const sorted = [...members].sort(([left], [right]) =>
		compareText(left, right),
	);
	if (sorted.length === 0) return '{}\n';
	return `{\n${sorted
		.map(([key, raw]) => `  ${JSON.stringify(key)}: ${raw}`)
		.join(',\n')}\n}\n`;
}
