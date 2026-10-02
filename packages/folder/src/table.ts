/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0462).
 *
 * An entry is one captured observation of a row file: its exact source, the
 * version of those bytes, the interpretation of its fields and body, and
 * conformance issues. Structured updates read current source once; complete
 * replacements use the supplied entry's baseline. Both conditionally publish
 * once and return a conflict without retrying (ADR-0464).
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * entry, it does not block creating the row, and renaming or deleting the row
 * leaves it where it is.
 */

import type { ParsedTable } from '@epicenter/definition';
import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	FileError,
	TableError,
	type TableReadError,
	type TableWriteError,
} from './errors.js';
import type { FolderContext } from './folder.js';
import { composeSource, patchSource, readSource } from './markdown.js';
import {
	collisionKey,
	pathProblem,
	ROW_EXTENSION,
	rowPath,
	rowStemOf,
	stemProblem,
} from './paths.js';
import {
	captureProblem,
	captureVersion,
	type FileCapture,
	type FileVersion,
	fileCapture,
} from './version.js';

export type EntryIssue =
	| { readonly kind: 'filename'; readonly message: string }
	| { readonly kind: 'frontmatter'; readonly message: string }
	| {
			readonly kind: 'field';
			readonly field: string;
			readonly message: string;
	  };

type EntryBase = {
	readonly path: string;
	readonly version: FileVersion;
	readonly source: string;
};

export type ValidEntry<TFields> = EntryBase & {
	readonly stem: string;
	readonly fields: Readonly<TFields>;
	readonly body: string;
	readonly issues: undefined;
};

export type InvalidEntry<TFields> = EntryBase & {
	readonly stem: string | undefined;
	/** Only declared fields that validated independently. */
	readonly fields: Readonly<Partial<TFields>>;
	readonly body: string | undefined;
	readonly issues: readonly [EntryIssue, ...EntryIssue[]];
};

/** One immutable observation of a row file. `issues` discriminates the variants. */
export type Entry<TFields> = ValidEntry<TFields> | InvalidEntry<TFields>;

export type TableListing<TFields> = {
	readonly entries: readonly Entry<TFields>[];
	/** Row files that were enumerated but whose bytes could not be read as UTF-8 text. */
	readonly unreadable: readonly {
		readonly path: string;
		readonly error: TableReadError | TableError;
	}[];
};

export type CreateInput<TFields> = {
	/** The file stem; generated when omitted. It is not the title. */
	readonly stem?: string;
	readonly fields: TFields;
	readonly body?: string;
};

export type FileTable<TFields> = {
	readonly name: string;
	list(): Promise<Result<TableListing<TFields>, TableReadError>>;
	get(
		stem: string,
	): Promise<Result<Entry<TFields> | undefined, TableReadError | TableError>>;
	create(
		input: CreateInput<TFields>,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	/** Assign fields/body on current source. A publication race returns Conflict; nothing retries. */
	update(
		stem: string,
		change: { readonly fields?: Partial<TFields>; readonly body?: string },
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	/** Save complete text against this entry's baseline, including invalid frontmatter for repair. */
	replace(
		entry: Entry<TFields>,
		source: string,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	/** Move the row file to another stem. No other file moves with it. */
	rename(
		entry: Entry<TFields>,
		nextStem: string,
	): Promise<Result<Entry<TFields>, TableWriteError>>;
	/** Remove the row file. No other file is removed with it. */
	delete(entry: Entry<TFields>): Promise<Result<undefined, TableWriteError>>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const generateStem = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
}

function invalidValues(
	parsed: ParsedTable,
	values: Readonly<Record<string, unknown>>,
	complete: boolean,
): Result<undefined, TableError> {
	const issues: { field: string; message: string }[] = [];
	for (const [key, value] of Object.entries(values)) {
		const field = parsed.fields.get(key);
		if (field === undefined)
			issues.push({ field: key, message: 'The field is not declared' });
		else if (!field.check(value))
			issues.push({
				field: key,
				message: `The value does not conform to its ${field.kind} field`,
			});
	}
	if (complete)
		for (const key of parsed.fields.keys())
			if (!Object.hasOwn(values, key))
				issues.push({ field: key, message: 'The field is required' });
	return issues.length === 0
		? Ok(undefined)
		: TableError.InvalidValues({ issues });
}

/** The exact file a new row is: its path, its source text, and that text's bytes. */
export type PreparedRow = {
	readonly stem: string;
	readonly path: string;
	readonly source: string;
	readonly bytes: Uint8Array;
};

/**
 * Validate and serialize a new row. A standalone `create` and a batched one
 * both write exactly what this returns, so a row has one source format
 * whichever way it is published. Synchronous: it reads nothing.
 */
export function prepareRow(
	table: string,
	parsed: ParsedTable,
	input: {
		readonly stem: string;
		readonly fields: unknown;
		readonly body?: string;
	},
): Result<PreparedRow, TableError> {
	const problem = stemProblem(input.stem);
	if (problem !== undefined)
		return TableError.InvalidStem({ stem: input.stem, reason: problem });
	const values = (input.fields ?? {}) as Record<string, unknown>;
	const valid = invalidValues(parsed, values, true);
	if (valid.error) return valid;
	const path = rowPath(table, input.stem);
	const ordered: Record<string, unknown> = {};
	for (const key of parsed.fields.keys()) ordered[key] = values[key];
	const composed = composeSource(ordered, input.body ?? '');
	if (composed.error)
		return TableError.UnsupportedSource({
			path,
			reason: composed.error.reason,
		});
	return Ok({
		stem: input.stem,
		path,
		source: composed.data,
		bytes: encoder.encode(composed.data),
	});
}

/** The filenames directly in a table's directory; none when it does not exist yet. */
export async function tableFilenames(
	boundary: Pick<FolderContext['boundary'], 'children'>,
	table: string,
): Promise<Result<string[], FileError>> {
	const children = await boundary.children(table);
	if (children.error) {
		if (children.error.name === 'NotFound') return Ok([]);
		return children;
	}
	return Ok(children.data.files);
}

/**
 * Refuse a row destination that exists or collides with a sibling on
 * case-insensitive filesystems. `files` are the table directory's filenames
 * as last observed; another program can still race them. A standalone create,
 * a rename, and a batched create all decide with this.
 */
export function destinationProblem(
	table: string,
	files: Iterable<string>,
	destination: string,
	ignore: string | undefined,
): Result<undefined, TableError> {
	const filename = destination.slice(table.length + 1);
	const key = collisionKey(destination);
	let collision: string | undefined;
	for (const existing of files) {
		if (existing === filename) return TableError.Exists({ path: destination });
		const path = `${table}/${existing}`;
		if (path !== ignore && collisionKey(path) === key) collision ??= path;
	}
	return collision === undefined
		? Ok(undefined)
		: TableError.Collision({ path: destination, existing: collision });
}

export function createFileTable<TFields>(
	name: string,
	parsed: ParsedTable,
	context: FolderContext,
): FileTable<TFields> {
	const { boundary } = context;
	const declared = [...parsed.fields.keys()];

	function interpret(
		path: string,
		version: FileVersion,
		source: string,
	): Entry<TFields> {
		const stem = path.slice(name.length + 1, -ROW_EXTENSION.length);
		const issues: EntryIssue[] = [];
		const stemIssue = stemProblem(stem);
		if (stemIssue !== undefined)
			issues.push({ kind: 'filename', message: stemIssue });
		const reading = readSource(source);
		for (const issue of reading.issues) issues.push(issue);
		const fields: Record<string, unknown> = {};
		if (reading.values !== undefined) {
			for (const key of declared) {
				const field = parsed.fields.get(key)!;
				if (!Object.hasOwn(reading.values, key)) {
					issues.push({
						kind: 'field',
						field: key,
						message: 'The field is missing',
					});
					continue;
				}
				const value = reading.values[key];
				if (field.check(value)) fields[key] = value;
				else
					issues.push({
						kind: 'field',
						field: key,
						message: `The value does not conform to its ${field.kind} field`,
					});
			}
		}
		const base = { path, version, source };
		if (issues.length === 0 && reading.body !== undefined)
			return Object.freeze({
				...base,
				stem,
				fields: Object.freeze(fields) as TFields,
				body: reading.body,
				issues: undefined,
			});
		return Object.freeze({
			...base,
			stem: stemIssue === undefined ? stem : undefined,
			fields: Object.freeze(fields) as Partial<TFields>,
			body: reading.body,
			issues: Object.freeze(issues) as unknown as readonly [
				EntryIssue,
				...EntryIssue[],
			],
		});
	}

	const directory = () => tableFilenames(boundary, name);
	const checkDestination = (
		files: readonly string[],
		destination: string,
		ignore: string | undefined,
	) => destinationProblem(name, files, destination, ignore);

	async function publishSource(
		entry: FileCapture,
		source: string,
	): Promise<Result<Entry<TFields>, TableWriteError>> {
		const captured = fileCapture(entry.path, entry.version);
		const bytes = encoder.encode(source);
		const version = await captureVersion(bytes);
		const applied = await context.publish([
			{
				kind: 'write',
				path: captured.path,
				bytes,
				version,
				expected: captured.version,
			},
		]);
		if (applied.error) return Err(applied.error);
		return Ok(interpret(captured.path, version, source));
	}

	/**
	 * The literal stem of a row file directly in this table's directory. A
	 * nested path such as `todos/a/b.md` is not a row. Stems that violate the
	 * naming rules are still rows here, so external files stay editable.
	 */
	function ownsPath(entry: Entry<TFields>): Result<string, FileError> {
		const problem = captureProblem(entry);
		if (problem !== undefined)
			return FileError.InvalidPath({
				path: String(entry?.path ?? ''),
				reason: problem,
			});
		const stem = rowStemOf(name, entry.path);
		if (stem === undefined)
			return FileError.InvalidPath({
				path: entry.path,
				reason: `the entry is not a row of '${name}'`,
			});
		return Ok(stem);
	}

	async function readEntry(
		stem: string,
	): Promise<Result<Entry<TFields> | undefined, TableReadError | TableError>> {
		const path = rowPath(name, stem);
		const problem = pathProblem(path);
		if (problem !== undefined)
			return FileError.InvalidPath({ path, reason: problem });
		// Existing external filenames need not conform to creation's naming rules.
		if (rowStemOf(name, path) !== stem)
			return TableError.InvalidStem({
				stem,
				reason: 'the stem contains a path separator',
			});
		const read = await boundary.read(path);
		if (read.error) {
			if (read.error.name === 'NotFound') return Ok(undefined);
			return read;
		}
		const source = decode(read.data.bytes);
		if (source === undefined) return TableError.InvalidUtf8({ path });
		return Ok(interpret(path, read.data.version, source));
	}

	return {
		name,
		async list() {
			return context.admit(
				async (): Promise<Result<TableListing<TFields>, TableReadError>> => {
					const found = await directory();
					if (found.error) return found;
					const rows = found.data.filter((file) =>
						file.endsWith(ROW_EXTENSION),
					);
					const reads = await boundary.readMany(
						rows.map((file) => `${name}/${file}`),
					);
					if (reads.error) return reads;
					const entries: Entry<TFields>[] = [];
					const unreadable: {
						path: string;
						error: TableReadError | TableError;
					}[] = [];
					for (const [path, read] of reads.data) {
						if (read.error) {
							unreadable.push({ path, error: read.error });
							continue;
						}
						const source = decode(read.data.bytes);
						if (source === undefined) {
							unreadable.push({
								path,
								error: TableError.InvalidUtf8({ path }).error,
							});
							continue;
						}
						entries.push(interpret(path, read.data.version, source));
					}
					return Ok({ entries, unreadable });
				},
			);
		},
		async get(stem) {
			return context.admit(() => readEntry(stem));
		},
		async create(input) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const prepared = prepareRow(name, parsed, {
						stem: input.stem ?? generateStem(),
						fields: input.fields,
						body: input.body,
					});
					if (prepared.error) return prepared;
					const { path, source, bytes } = prepared.data;
					const found = await directory();
					if (found.error) return found;
					const destination = checkDestination(found.data, path, undefined);
					if (destination.error) return destination;
					const version = await captureVersion(bytes);
					const applied = await context.publish([
						{ kind: 'write', path, bytes, version, expected: 'absent' },
					]);
					if (applied.error) return Err(applied.error);
					return Ok(interpret(path, version, source));
				},
			);
		},
		async update(stem, change) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					let values = (change.fields ?? {}) as Record<string, unknown>;
					const valid = invalidValues(parsed, values, false);
					if (valid.error) return valid;
					// Own nested JSON/array values before the first asynchronous read.
					try {
						values = structuredClone(values);
					} catch {
						return TableError.UnsupportedSource({
							path: rowPath(name, stem),
							reason: 'the supplied fields cannot be copied',
						});
					}
					const body = change.body;
					const read = await readEntry(stem);
					if (read.error) return read;
					const entry = read.data;
					if (entry === undefined)
						return FileError.NotFound({ path: rowPath(name, stem) });
					const patched = patchSource(entry.source, {
						fields: values,
						body,
					});
					if (patched.error)
						return TableError.UnsupportedSource({
							path: entry.path,
							reason: patched.error.reason,
						});
					return publishSource(entry, patched.data);
				},
			);
		},
		async replace(entry, source) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					return publishSource(entry, source);
				},
			);
		},
		async rename(entry, nextStem) {
			return context.admit(
				async (): Promise<Result<Entry<TFields>, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					const captured = fileCapture(entry.path, entry.version);
					const source = entry.source;
					const problem = stemProblem(nextStem);
					if (problem !== undefined)
						return TableError.InvalidStem({ stem: nextStem, reason: problem });
					const path = rowPath(name, nextStem);
					if (path === captured.path) return Ok(entry);
					const found = await directory();
					if (found.error) return found;
					const destination = checkDestination(found.data, path, captured.path);
					if (destination.error) return destination;
					const applied = await context.publish([
						{
							kind: 'move',
							from: captured.path,
							to: path,
							expected: captured.version,
						},
					]);
					if (applied.error) return Err(applied.error);
					return Ok(interpret(path, captured.version, source));
				},
			);
		},
		async delete(entry) {
			return context.admit(
				async (): Promise<Result<undefined, TableWriteError>> => {
					const owned = ownsPath(entry);
					if (owned.error) return owned;
					const captured = fileCapture(entry.path, entry.version);
					return context.publish([
						{ kind: 'remove', path: captured.path, expected: captured.version },
					]);
				},
			);
		},
	};
}
