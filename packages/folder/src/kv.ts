/**
 * The root `kv.json`: a sparse map of declared values (ADR-0487).
 *
 * A snapshot is a text capture of the file and how that text reads: the
 * declared values that validated, a parse error when the text is not one
 * JSON object, and an issue for each stored value that does not conform. A
 * key the file lacks is not an issue, and nothing here supplies a default:
 * what a missing key means belongs to the application.
 *
 * `create` saves a new file from the supplied values alone and reads
 * nothing. `update` reads the file once, assigns the supplied root keys
 * inside its exact source, and conditionally replaces what it read: a
 * publication race returns Conflict and nothing retries.
 *
 * An update changes only the value of each supplied key. Unknown keys,
 * number spellings, nesting, whitespace, and a byte order mark stay exactly
 * as they were. Source that is not one strict JSON object is refused; repair
 * it as an ordinary file with `files.replace(snapshot, source)`.
 */

import {
	accepts,
	type FieldMap,
	inputIssues,
	isJsonValue,
	JSON_BUDGET,
} from '@epicenter/definition';
import {
	type ParseError as JsonSyntaxError,
	type Node,
	parseTree,
} from 'jsonc-parser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage, Submission } from './boundary.js';
import { hashBytes } from './capture.js';
import {
	describe,
	type KvReadError,
	type KvWriteError,
	TableError,
} from './errors.js';
import {
	type DeepReadonly,
	type FieldIssue,
	freezeDeep,
	freezeIssues,
	ownSupplied,
	type ParseError,
	parseError,
} from './reading.js';
import { applyOne, reserveSubmission } from './storage.js';

export const KV_PATH = 'kv.json';

/**
 * How `kv.json` source reads. Text that is not one JSON object has a
 * `parseError`, no values, and no issues. Text that parses has every stored
 * declared value that validated by itself; a stored value that does not
 * conform is left out and reported. A key the source lacks is left out and
 * is not an issue, and an undeclared key stays in the source unreported.
 */
export type KvReading<TValues> = {
	readonly values: DeepReadonly<Partial<TValues>>;
	readonly parseError: ParseError | undefined;
	readonly issues: readonly FieldIssue[];
};

/** One immutable observation of `kv.json`, or the capture a save left behind. */
export type KvSnapshot<TValues> = KvReading<TValues> & {
	readonly path: typeof KV_PATH;
	readonly source: string;
	readonly sha256: string;
};

export type FileKv<TValues> = {
	/**
	 * Interpret `kv.json` source. Synchronous and pure: it reads no file and
	 * invents no capture, so unsaved text can be inspected.
	 */
	inspect(source: string): KvReading<TValues>;
	/**
	 * `undefined` only when `kv.json` does not exist. Text that is not a JSON
	 * object is a snapshot with a `parseError`; a file that cannot be read is
	 * an error.
	 */
	get(): Promise<Result<KvSnapshot<TValues> | undefined, KvReadError>>;
	/**
	 * Save a new `kv.json` holding the supplied values. Refused when the file
	 * exists. The supplied values are copied, never frozen or kept.
	 */
	create(
		values: DeepReadonly<Partial<TValues>>,
	): Promise<Result<KvSnapshot<TValues>, KvWriteError>>;
	/**
	 * Assign the supplied keys in the current file. A missing file is NotFound
	 * and a publication race is Conflict; nothing retries.
	 */
	update(
		values: DeepReadonly<Partial<TValues>>,
	): Promise<Result<KvSnapshot<TValues>, KvWriteError>>;
};

const BOM = '﻿';
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

/**
 * The root object of strict JSON text, or why there is none. Comments and
 * trailing commas do not parse. A root key that appears twice reads as its
 * last value.
 */
function parseObject(
	json: string,
): Result<Record<string, unknown>, ParseError> {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (cause) {
		return Err(parseError('The source is not valid JSON', [describe(cause)]));
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return Err(parseError('The source is not a JSON object'));
	return Ok(value as Record<string, unknown>);
}

/**
 * Interpret `kv.json` source against the definition's prepared `kv` fields.
 * Parsing comes first and fails as a whole. The shared input check then
 * checks each stored declared value by itself; nothing is coerced,
 * defaulted, or repaired.
 *
 * The values are this parse's own, so freezing them at every depth touches
 * nothing a caller holds. They are frozen before a field checks them, so a
 * field's callback cannot make a reading say what its source does not.
 */
function inspectSource<TValues>(
	schemas: FieldMap,
	source: string,
): KvReading<TValues> {
	const { data: object, error: objectError } = parseObject(
		source.startsWith(BOM) ? source.slice(BOM.length) : source,
	);
	if (objectError !== null)
		return Object.freeze({
			values: Object.freeze({}) as DeepReadonly<Partial<TValues>>,
			parseError: objectError,
			issues: freezeIssues([]),
		});
	const stored: Record<string, unknown> = {};
	for (const key of Object.keys(schemas))
		if (Object.hasOwn(object, key)) stored[key] = freezeDeep(object[key]);
	// Only stored declared keys are checked, so an absent key is never an issue.
	const issues = inputIssues(schemas, stored, { complete: false });
	for (const { field } of issues) delete stored[field];
	return Object.freeze({
		// Every value is frozen already; only the map that holds them is new.
		values: Object.freeze(stored) as DeepReadonly<Partial<TValues>>,
		parseError: undefined,
		issues: freezeIssues(issues),
	});
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
 * its object after the call cannot change what is saved. The caller's object
 * is read and never frozen or kept: what is checked and serialized is this
 * module's frozen copy.
 */
function ownValues(
	schemas: FieldMap,
	supplied: Readonly<Record<string, unknown>>,
): Result<Map<string, string>, Extract<TableError, { name: 'InvalidValues' }>> {
	const owned = new Map<string, string>();
	// The input check says which keys are undeclared or do not conform, and where.
	const { values, issues } = ownSupplied(schemas, supplied, {
		complete: false,
	});
	const refused = new Set(issues.map((issue) => issue.field));
	for (const [key, value] of Object.entries(values)) {
		if (refused.has(key)) continue;
		// A value its field accepts is JSON already, so what the bounded guard
		// refuses here is size, and the issue says so.
		if (!isJsonValue(value)) {
			issues.push({
				field: key,
				message: `${key} is over the kv.json budget: nesting deeper than ${JSON_BUDGET.depth} levels, or an object with more than ${JSON_BUDGET.propertiesPerObject} keys`,
			});
			continue;
		}
		const json = serialize(value);
		// The saved text is what a reader gets back, so it has to conform too.
		// The key passed the input check above, so it is a declared field.
		if (
			json !== undefined &&
			accepts(schemas[key], freezeDeep(JSON.parse(json)))
		)
			owned.set(key, json);
		else
			issues.push({
				field: key,
				message: `${key} cannot be saved: the value does not read back from JSON as it was supplied`,
			});
	}
	return issues.length === 0 ? Ok(owned) : TableError.InvalidValues({ issues });
}

/**
 * Assign root keys in exact source. Only the span of each assigned value
 * changes; a key the object lacks is added after its last member.
 *
 * Source that is not one JSON object is `Unparsed`: there is nothing to
 * assign in. Source that parses but cannot take the assignment safely is
 * `UnsupportedSource`.
 */
function assignKeys(
	source: string,
	owned: ReadonlyMap<string, string>,
): Result<
	string,
	Extract<TableError, { name: 'Unparsed' | 'UnsupportedSource' }>
> {
	const refuse = (reason: string) =>
		TableError.UnsupportedSource({ path: KV_PATH, reason });
	const prefix = source.startsWith(BOM) ? BOM : '';
	const json = source.slice(prefix.length);
	const { error: currentError } = parseObject(json);
	if (currentError !== null)
		return TableError.Unparsed({ path: KV_PATH, error: currentError });

	// JSON.parse says the text is strict JSON; the syntax tree says where each
	// member is. Text the two disagree on is not patched.
	const errors: JsonSyntaxError[] = [];
	let root: Node | undefined;
	try {
		root = parseTree(json, errors, STRICT_JSON);
	} catch (cause) {
		return refuse(`kv.json could not be located: ${describe(cause)}`);
	}
	if (root?.type !== 'object' || errors.length > 0)
		return refuse('the members of kv.json could not be located');
	const members = root.children ?? [];

	// A key spelled with escapes is the same key. JSON.parse reads the last
	// occurrence, so assigning one of several would not change what is read.
	const targets = new Map<string, Node>();
	for (const member of members) {
		const [name, value] = member.children ?? [];
		if (name === undefined || value === undefined)
			return refuse('the members of kv.json could not be located');
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
	const { data: reread, error: rereadError } = parseObject(patched);
	if (rereadError !== null)
		return refuse(`the patched text does not parse: ${rereadError.message}`);
	for (const [key, text] of owned)
		if (!Object.hasOwn(reread, key) || JSON.stringify(reread[key]) !== text)
			return refuse(`the key '${key}' could not be assigned`);
	return Ok(prefix + patched);
}

/** The `kv.json` handle. `schemas` are the prepared definition's `kv` fields. */
export function createKv<TValues>(
	{ storage }: { storage: FolderStorage },
	schemas: FieldMap,
): FileKv<TValues> {
	const inspect = (source: string) => inspectSource<TValues>(schemas, source);

	/** The snapshot of captured bytes: what was read, or exactly what was submitted. */
	function snapshotOf(source: string, sha256: string): KvSnapshot<TValues> {
		return Object.freeze({
			path: KV_PATH,
			sha256,
			source,
			...inspect(source),
		});
	}

	/**
	 * Publish once and return the snapshot of the submitted source; nothing is
	 * read back. The source is well-formed text, built from JSON this module
	 * serialized and from decoded UTF-8, so it is exactly the text of its bytes.
	 * `submission` is the place the public method reserved when it was entered.
	 */
	async function publish(
		submission: Submission,
		source: string,
		condition: { kind: 'create' } | { kind: 'replace'; expectedSha256: string },
	): Promise<Result<KvSnapshot<TValues>, KvWriteError>> {
		const bytes = encoder.encode(source);
		const sha256 = await hashBytes(bytes);
		// Interpret before publication; returning the receipt needs no further validation.
		const receipt = snapshotOf(source, sha256);
		const { error: applyError } = await applyOne(
			storage,
			{ ...condition, path: KV_PATH, bytes, sha256 },
			submission,
		);
		if (applyError !== null) return Err(applyError);
		return Ok(receipt);
	}

	return {
		inspect,
		async get() {
			const { data: read, error: readError } = await storage.read(KV_PATH);
			if (readError !== null)
				return readError.name === 'NotFound' ? Ok(undefined) : Err(readError);
			const source = decode(read.bytes);
			if (source === undefined)
				return TableError.InvalidUtf8({ path: KV_PATH });
			return Ok(snapshotOf(source, read.sha256));
		},
		async create(values) {
			const submission = reserveSubmission();
			const { data: owned, error: valuesError } = ownValues(
				schemas,
				values as Record<string, unknown>,
			);
			if (valuesError !== null) return Err(valuesError);
			const object = Object.fromEntries(
				[...owned].map(([key, json]) => [key, JSON.parse(json)]),
			);
			return publish(submission, `${JSON.stringify(object, null, 2)}\n`, {
				kind: 'create',
			});
		},
		async update(values) {
			const submission = reserveSubmission();
			const { data: owned, error: valuesError } = ownValues(
				schemas,
				values as Record<string, unknown>,
			);
			if (valuesError !== null) return Err(valuesError);
			const { data: read, error: readError } = await storage.read(KV_PATH);
			if (readError !== null) return Err(readError);
			const source = decode(read.bytes);
			if (source === undefined)
				return TableError.InvalidUtf8({ path: KV_PATH });
			const { data: patched, error: patchError } = assignKeys(source, owned);
			if (patchError !== null) return Err(patchError);
			return publish(submission, patched, {
				kind: 'replace',
				expectedSha256: read.sha256,
			});
		},
	};
}
