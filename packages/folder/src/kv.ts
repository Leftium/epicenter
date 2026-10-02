/**
 * Root `kv.json` settings for a file folder.
 *
 * A snapshot is a text capture of the file with the declared values that
 * validated. `create` saves a new file from the supplied values alone and
 * reads nothing. `update` reads the file once, assigns the supplied root keys
 * inside its exact source, and conditionally replaces what it read: a
 * publication race returns Conflict and nothing retries.
 *
 * An update changes only the value of each supplied key. Unknown keys,
 * number spellings, nesting, whitespace, and a byte order mark stay exactly
 * as they were. Source that is not one strict JSON object is refused; repair
 * it as an ordinary file with `files.replace(snapshot, source)`.
 */

import {
	isJsonValue,
	JSON_BUDGET,
	type ParsedTable,
} from '@epicenter/definition';
import { type Node, type ParseError, parseTree } from 'jsonc-parser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { hashBytes, type TextCapture } from './capture.js';
import {
	describe,
	type FileError,
	TableError,
	type TableWriteError,
} from './errors.js';

export const KV_PATH = 'kv.json';

export type KvIssue = {
	readonly field: string | undefined;
	readonly message: string;
};

/** One immutable observation of `kv.json`, or the capture a save left behind. */
export type KvSnapshot<TValues> = Readonly<TextCapture> & {
	readonly path: typeof KV_PATH;
	/** Declared values that validated independently. */
	readonly values: Readonly<Partial<TValues>>;
	readonly issues: readonly KvIssue[] | undefined;
};

export type FileKv<TValues> = {
	/**
	 * `undefined` when `kv.json` does not exist. Text that is not a JSON object
	 * is a snapshot with issues; a file that cannot be read is an error.
	 */
	get(): Promise<
		Result<KvSnapshot<TValues> | undefined, FileError | TableError>
	>;
	/** Save a new `kv.json` holding the supplied values. Refused when the file exists. */
	create(
		values: Partial<TValues>,
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>>;
	/**
	 * Assign the supplied keys in the current file. A missing file is NotFound
	 * and a publication race is Conflict; nothing retries.
	 */
	update(
		values: Partial<TValues>,
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>>;
};

const BOM = '\uFEFF';
const STRICT_JSON = {
	disallowComments: true,
	allowTrailingComma: false,
	allowEmptyContent: false,
};
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

/** The root object of strict JSON text, or why there is none. */
function parseObject(json: string): Result<Record<string, unknown>, string> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (cause) {
		return Err(`kv.json is not valid JSON: ${describe(cause)}`);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return Err('kv.json is not a JSON object');
	return Ok(value as Record<string, unknown>);
}

/** JSON text of a value, or `undefined` where serializing would drop or replace part of it. */
function serialize(value: unknown): string | undefined {
	try {
		return JSON.stringify(value, (_key, part: unknown) => {
			if (
				part === undefined ||
				typeof part === 'function' ||
				typeof part === 'symbol' ||
				(typeof part === 'number' && !Number.isFinite(part))
			)
				throw new TypeError('not a JSON value');
			return part;
		});
	} catch {
		return undefined;
	}
}

/**
 * Supplied values as JSON text by key. Synchronous, so a caller that changes
 * its object after the call cannot change what is saved.
 */
function ownValues(
	parsed: ParsedTable,
	values: Readonly<Record<string, unknown>>,
): Result<Map<string, string>, TableError> {
	const owned = new Map<string, string>();
	const issues: { field: string; message: string }[] = [];
	for (const [key, value] of Object.entries(values)) {
		const field = parsed.fields.get(key);
		if (field === undefined) {
			issues.push({ field: key, message: 'The key is not declared' });
			continue;
		}
		const conforms = field.check(value);
		// A value its field accepts is JSON already, so what the bounded guard
		// refuses here is size, and the issue says so.
		if (conforms && !isJsonValue(value)) {
			issues.push({
				field: key,
				message: `The value is over the kv.json budget: nesting deeper than ${JSON_BUDGET.depth} levels, or an object with more than ${JSON_BUDGET.propertiesPerObject} keys`,
			});
			continue;
		}
		const json = conforms && serialize(value);
		// The saved text is what a reader gets back, so it has to conform too.
		if (typeof json === 'string' && field.check(JSON.parse(json)))
			owned.set(key, json);
		else
			issues.push({
				field: key,
				message: 'The value does not conform to its declared schema',
			});
	}
	return issues.length === 0 ? Ok(owned) : TableError.InvalidValues({ issues });
}

/**
 * Assign root keys in exact source. Only the span of each assigned value
 * changes; a key the object lacks is added after its last member.
 */
function assignKeys(
	source: string,
	owned: ReadonlyMap<string, string>,
): Result<string, TableError> {
	const refuse = (reason: string) =>
		TableError.UnsupportedSource({ path: KV_PATH, reason });
	const prefix = source.startsWith(BOM) ? BOM : '';
	const json = source.slice(prefix.length);
	const current = parseObject(json);
	if (current.error !== null) return refuse(current.error);

	// JSON.parse says the text is strict JSON; the syntax tree says where each
	// member is. Text the two disagree on is not patched.
	const errors: ParseError[] = [];
	let root: Node | undefined;
	try {
		root = parseTree(json, errors, STRICT_JSON);
	} catch (cause) {
		return refuse(`kv.json could not be parsed: ${describe(cause)}`);
	}
	if (root?.type !== 'object' || errors.length > 0)
		return refuse('kv.json could not be parsed as one JSON object');
	const members = root.children ?? [];

	// A key spelled with escapes is the same key. JSON.parse reads the last
	// occurrence, so assigning one of several would not change what is read.
	const targets = new Map<string, Node>();
	for (const member of members) {
		const [name, value] = member.children ?? [];
		if (name === undefined || value === undefined)
			return refuse('kv.json could not be parsed as one JSON object');
		const key: unknown = name.value;
		if (typeof key !== 'string' || !owned.has(key)) continue;
		if (targets.has(key))
			return refuse(`the key '${key}' appears more than once`);
		targets.set(key, value);
	}

	const edits: { offset: number; end: number; text: string }[] = [];
	const added: [key: string, json: string][] = [];
	for (const [key, text] of owned) {
		const target = targets.get(key);
		if (target === undefined) added.push([key, text]);
		else
			edits.push({
				offset: target.offset,
				end: target.offset + target.length,
				text,
			});
	}
	const [lastName, lastValue] = members.at(-1)?.children ?? [];
	if (added.length > 0) {
		if (lastName === undefined || lastValue === undefined)
			edits.push({
				offset: root.offset + 1,
				end: root.offset + root.length - 1,
				text: `\n${added.map(([key, text]) => `  ${JSON.stringify(key)}: ${text}`).join(',\n')}\n`,
			});
		else {
			// New members repeat the whitespace before the last member and the
			// separator between its key and value.
			let leadStart = lastName.offset;
			while (leadStart > 0 && ' \t\r\n'.includes(json.charAt(leadStart - 1)))
				leadStart -= 1;
			const lead = json.slice(leadStart, lastName.offset);
			const separator = json.slice(
				lastName.offset + lastName.length,
				lastValue.offset,
			);
			const end = lastValue.offset + lastValue.length;
			edits.push({
				offset: end,
				end,
				text: added
					.map(
						([key, text]) =>
							`,${lead}${JSON.stringify(key)}${separator}${text}`,
					)
					.join(''),
			});
		}
	}

	// The spans are disjoint, so applying the last one first keeps every
	// earlier offset valid.
	let patched = json;
	for (const edit of edits.sort((a, b) => b.offset - a.offset))
		patched =
			patched.slice(0, edit.offset) + edit.text + patched.slice(edit.end);

	// Publish only text that reads back as the supplied values.
	const result = parseObject(patched);
	if (result.error !== null) return refuse(result.error);
	for (const [key, text] of owned)
		if (
			!Object.hasOwn(result.data, key) ||
			JSON.stringify(result.data[key]) !== text
		)
			return refuse(`the key '${key}' could not be assigned`);
	return Ok(prefix + patched);
}

export function createKv<TValues>(
	{ storage }: { storage: FolderStorage },
	parsed: ParsedTable,
): FileKv<TValues> {
	function interpret(source: string, sha256: string): KvSnapshot<TValues> {
		const issues: KvIssue[] = [];
		const values: [string, unknown][] = [];
		const object = parseObject(
			source.startsWith(BOM) ? source.slice(BOM.length) : source,
		);
		if (object.error !== null)
			issues.push({ field: undefined, message: object.error });
		else
			for (const [key, field] of parsed.fields) {
				if (!Object.hasOwn(object.data, key)) continue;
				const value = object.data[key];
				if (field.check(value)) values.push([key, value]);
				else
					issues.push({
						field: key,
						message: 'The value does not conform to its declared schema',
					});
			}
		return Object.freeze({
			path: KV_PATH,
			sha256,
			source,
			values: Object.freeze(Object.fromEntries(values)) as Partial<TValues>,
			issues: issues.length === 0 ? undefined : Object.freeze(issues),
		});
	}

	/** Publish once and return the capture of the submitted source; nothing is read back. */
	async function publish(
		source: string,
		condition: { kind: 'create' } | { kind: 'replace'; expectedSha256: string },
	): Promise<Result<KvSnapshot<TValues>, TableWriteError>> {
		const bytes = encoder.encode(source);
		const sha256 = await hashBytes(bytes);
		const applied = await storage.apply([
			{ ...condition, path: KV_PATH, bytes, sha256 },
		]);
		if (applied.error) return Err(applied.error);
		return Ok(interpret(source, sha256));
	}

	return {
		async get() {
			const read = await storage.read(KV_PATH);
			if (read.error)
				return read.error.name === 'NotFound' ? Ok(undefined) : read;
			const source = decode(read.data.bytes);
			if (source === undefined)
				return TableError.InvalidUtf8({ path: KV_PATH });
			return Ok(interpret(source, read.data.sha256));
		},
		async create(values) {
			const owned = ownValues(parsed, values as Record<string, unknown>);
			if (owned.error) return owned;
			const object = Object.fromEntries(
				[...owned.data].map(([key, json]) => [key, JSON.parse(json)]),
			);
			return publish(`${JSON.stringify(object, null, 2)}\n`, {
				kind: 'create',
			});
		},
		async update(values) {
			const owned = ownValues(parsed, values as Record<string, unknown>);
			if (owned.error) return owned;
			const read = await storage.read(KV_PATH);
			if (read.error) return read;
			const source = decode(read.data.bytes);
			if (source === undefined)
				return TableError.InvalidUtf8({ path: KV_PATH });
			const patched = assignKeys(source, owned.data);
			if (patched.error) return patched;
			return publish(patched.data, {
				kind: 'replace',
				expectedSha256: read.data.sha256,
			});
		},
	};
}
