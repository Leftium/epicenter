/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0462).
 *
 * A snapshot is one captured row file: its literal path and stem, its exact
 * source, the SHA-256 of those bytes, and how that text reads. Reading the
 * file and interpreting its text are separate. A file that was read is a
 * snapshot even when its text does not parse. A parse failure and a field
 * that does not conform are different things: the first leaves no fields or
 * body at all, the second leaves every field that validated.
 *
 * `inspect` is that interpretation by itself: reads, save receipts, and
 * editors checking an unsaved buffer all use it.
 *
 * Structured updates read current source once; complete replacements use the
 * supplied capture's baseline. Both conditionally publish once and return a
 * conflict without retrying (ADR-0464).
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * snapshot, it does not block creating the row, and renaming or deleting the
 * row leaves it where it is.
 */

import { isJsonSafe, type ParsedTable } from '@epicenter/definition';
import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import {
	type FileCapture,
	hashBytes,
	ownCapture,
	type TextCapture,
} from './capture.js';
import {
	FileError,
	type TableCreateError,
	type TableDeleteError,
	type TableEnumerationError,
	TableError,
	type TableGetError,
	type TableReadError,
	type TableRenameError,
	type TableReplaceError,
	type TableUpdateError,
} from './errors.js';
import {
	composeSource,
	parseSource,
	patchSource,
	valueProblem,
} from './markdown.js';
import {
	ROW_EXTENSION,
	rowAddressProblem,
	rowPath,
	rowStemOf,
} from './paths.js';
import {
	type DeepReadonly,
	type FieldIssue,
	freezeDeep,
	freezeIssues,
	ownSupplied,
	type ParseError,
} from './reading.js';

/**
 * How row source reads. Text that does not parse has a `parseError`, no
 * fields, no body, and no issues. Text that parses has a body and every
 * declared field that validated by itself, so one field's issue does not
 * hide another field's value.
 *
 * `fields` is always partial: an empty `issues` does not make it a complete
 * row, so check the fields an action needs. Every declared field the source
 * lacks is an issue. Keys the table does not declare stay in the source and
 * are not issues.
 */
export type TableReading<TFields> = {
	readonly fields: DeepReadonly<Partial<TFields>>;
	/** The text after the closing fence, possibly empty; `undefined` when the source does not parse. */
	readonly body: string | undefined;
	readonly parseError: ParseError | undefined;
	readonly issues: readonly FieldIssue[];
};

/**
 * One immutable capture of a row file and how its text reads. `source` and
 * `sha256` always describe the same bytes, and the reading is of that source.
 * It is the same repair baseline whether or not the text parses.
 */
export type TableSnapshot<TFields> = TableReading<TFields> & {
	readonly path: string;
	/**
	 * The literal filename without `.md`: `path` is `rowPath(table.name, stem)`.
	 * It may be empty (`<table>/.md`), so never test it by truthiness.
	 */
	readonly stem: string;
	readonly source: string;
	readonly sha256: string;
};

/**
 * One item for every `.md` file directly in the table's directory, in no
 * promised order. A file whose text was read is a snapshot, parsed or not. A
 * file that could not be read, is not UTF-8, or went away after it was
 * enumerated is that item's error.
 */
export type TableListing<TFields> = readonly {
	readonly path: string;
	readonly result: Result<TableSnapshot<TFields>, TableReadError>;
}[];

export type FileTable<TFields> = {
	readonly name: string;
	/**
	 * Interpret row source: parse it once, then check each declared field by
	 * itself. Synchronous and pure: it reads no file and invents no capture, so
	 * an editor can inspect the text it has not saved.
	 */
	inspect(source: string): TableReading<TFields>;
	/** An outer error means the listing itself failed; no partial listing is returned. */
	list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
	/** `undefined` only when no file is at the stem. A file whose text does not parse is still a snapshot. */
	get(
		stem: string,
	): Promise<Result<TableSnapshot<TFields> | undefined, TableGetError>>;
	/**
	 * Save a new row. The source always has both fences, even with no fields
	 * and no body. The supplied values are copied, never frozen or kept.
	 */
	create(input: {
		/** The file stem; generated when omitted. It is not the title. */
		readonly stem?: string;
		readonly fields: DeepReadonly<TFields>;
		readonly body?: string;
	}): Promise<Result<TableSnapshot<TFields>, TableCreateError>>;
	/**
	 * Assign fields/body in current source. The source must parse, for a body
	 * change too; other fields may have issues. A publication race returns
	 * Conflict; nothing retries, and nothing is rewritten on a refusal.
	 */
	update(
		stem: string,
		change: {
			readonly fields?: DeepReadonly<Partial<TFields>>;
			readonly body?: string;
		},
	): Promise<Result<TableSnapshot<TFields>, TableUpdateError>>;
	/**
	 * Save complete text against this capture's baseline, exactly as given.
	 * Text that does not parse is saved all the same: the returned snapshot
	 * then has a `parseError`, and the save still succeeded.
	 */
	replace(
		capture: FileCapture,
		source: string,
	): Promise<Result<TableSnapshot<TFields>, TableReplaceError>>;
	/**
	 * Move the row file to another stem. No other file moves with it. The
	 * capture's `source` must be the text of its `sha256`: the returned
	 * snapshot reads that text, so a capture whose two halves disagree is
	 * refused as `InvalidPath` before anything moves.
	 */
	rename(
		capture: TextCapture,
		nextStem: string,
	): Promise<Result<TableSnapshot<TFields>, TableRenameError>>;
	/** Remove the row file. No other file is removed with it. */
	delete(capture: FileCapture): Promise<Result<undefined, TableDeleteError>>;
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

/**
 * The bytes a save submits and the text those bytes are. Encoding replaces
 * an unpaired surrogate, so a receipt's source is the text of the bytes, not
 * a string assumed to equal them. The text is always decoded from the bytes,
 * with the decoder that reads files: a byte-order mark stays in it.
 */
function submitted(source: string): { bytes: Uint8Array; source: string } {
	const bytes = encoder.encode(source);
	return { bytes, source: utf8.decode(bytes) };
}

/**
 * Interpret row source against a compiled table. Parsing comes first and
 * fails as a whole. The definition compiler then checks each declared field
 * by itself; nothing is coerced, defaulted, or repaired.
 *
 * The values are this parse's own, so freezing them at every depth touches
 * nothing a caller holds. Each declared value that is JSON is frozen before
 * the compiler sees it, so a field's callback cannot make a reading say what
 * its source does not.
 *
 * YAML can also hold what JSON cannot: a `!!binary` byte array, a date, a
 * set, a map, a number that is not finite. A declared value like that is
 * handed over as it is, since a byte array cannot be frozen: the compiler
 * refuses it as an issue before any callback runs. A key the table does not
 * declare is never checked, so nothing here touches its value.
 */
export function inspectSource<TFields>(
	parsed: ParsedTable,
	source: string,
): TableReading<TFields> {
	const read = parseSource(source);
	if (read.error)
		return Object.freeze({
			fields: Object.freeze({}) as DeepReadonly<Partial<TFields>>,
			body: undefined,
			parseError: read.error,
			issues: freezeIssues([]),
		});
	const declared: Record<string, unknown> = {};
	for (const key of parsed.fields.keys()) {
		if (!Object.hasOwn(read.data.values, key)) continue;
		const value = read.data.values[key];
		declared[key] = isJsonSafe(value) ? freezeDeep(value) : value;
	}
	const { conforming, issues } = parsed.conformance(declared);
	return Object.freeze({
		// Every value is frozen already; only the map that holds them is new.
		fields: Object.freeze(conforming) as DeepReadonly<Partial<TFields>>,
		body: read.data.body,
		parseError: undefined,
		issues: freezeIssues(issues),
	});
}

/** The row path a literal stem addresses, or the refusal of a stem that is not one filename segment in this folder. */
function rowAddress(
	table: string,
	stem: string,
): Result<string, Extract<FileError, { name: 'InvalidPath' }>> {
	const problem = rowAddressProblem(table, stem);
	if (problem !== undefined)
		return FileError.InvalidPath({
			path: rowPath(table, String(stem)),
			reason: problem,
		});
	return Ok(rowPath(table, stem));
}

/**
 * Supplied values as the table will save them: the table's own frozen
 * copies, checked by the definition compiler and known to be writable as
 * YAML. Synchronous, so it finishes before anything is read.
 */
function ownValues(
	parsed: ParsedTable,
	supplied: unknown,
	complete: boolean,
): Result<
	Record<string, unknown>,
	Extract<TableError, { name: 'InvalidValues' }>
> {
	const { values, issues } = ownSupplied(
		parsed,
		(supplied ?? {}) as Record<string, unknown>,
		{ complete },
	);
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	for (const [key, value] of Object.entries(values)) {
		const problem = valueProblem(value);
		if (problem !== undefined)
			issues.push({
				field: key,
				message: `${key} cannot be saved: ${problem}`,
			});
	}
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	return Ok(values);
}

/** The exact file a new row is: its path, its source text, and that text's bytes. */
type PreparedRow = {
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
	parsed: ParsedTable,
	input: {
		readonly stem: string;
		readonly fields: unknown;
		readonly body?: string;
	},
): Result<
	PreparedRow,
	Extract<TableCreateError, { name: 'InvalidPath' | 'InvalidValues' }>
> {
	const address = rowAddress(parsed.name, input.stem);
	if (address.error) return address;
	const values = ownValues(parsed, input.fields, true);
	if (values.error) return values;
	const ordered: Record<string, unknown> = {};
	for (const key of parsed.fields.keys()) ordered[key] = values.data[key];
	const composed = composeSource(ordered, input.body ?? '');
	if (composed.error)
		return TableError.InvalidValues({
			issues: [
				{
					field: composed.error.field,
					message: `${composed.error.field} cannot be saved: ${composed.error.reason}`,
				},
			],
		});
	return Ok({ path: address.data, ...submitted(composed.data) });
}

/** The filenames directly in a table's directory; none when it does not exist yet. */
export async function tableFilenames(
	storage: Pick<FolderStorage, 'children'>,
	table: string,
): Promise<Result<string[], TableEnumerationError>> {
	const children = await storage.children(table);
	if (children.error) {
		if (children.error.name === 'NotFound') return Ok([]);
		return Err(children.error);
	}
	return Ok(children.data.files);
}

export function createTable<TFields>(
	{ storage }: { storage: FolderStorage },
	parsed: ParsedTable,
): FileTable<TFields> {
	const { name } = parsed;

	const inspect = (source: string) => inspectSource<TFields>(parsed, source);

	/** The snapshot of captured bytes: what was read, or exactly what was submitted. */
	function snapshotOf(
		path: string,
		sha256: string,
		source: string,
	): TableSnapshot<TFields> {
		return Object.freeze({
			path,
			stem: path.slice(name.length + 1, -ROW_EXTENSION.length),
			sha256,
			source,
			...inspect(source),
		});
	}

	/** Interpret the bytes of one read, or say why they are not text. */
	function readSnapshot(
		path: string,
		read: { bytes: Uint8Array; sha256: string },
	): Result<
		TableSnapshot<TFields>,
		Extract<TableError, { name: 'InvalidUtf8' }>
	> {
		const source = decode(read.bytes);
		if (source === undefined) return TableError.InvalidUtf8({ path });
		return Ok(snapshotOf(path, read.sha256, source));
	}

	/**
	 * The one destination check before publication (ADR-0477): refuse a path a
	 * file already occupies, by the table's directory as it was just read.
	 * Names are compared exactly. Another program can still take the path
	 * afterward, and a filesystem that holds one file for two spellings refuses
	 * the second at publication, where the exclusive destination condition runs.
	 */
	async function vacant(
		path: string,
	): Promise<
		Result<
			undefined,
			TableEnumerationError | Extract<FileError, { name: 'Exists' }>
		>
	> {
		const found = await tableFilenames(storage, name);
		if (found.error) return found;
		if (found.data.includes(path.slice(name.length + 1)))
			return FileError.Exists({ path });
		return Ok(undefined);
	}

	/**
	 * Own a capture of a row file directly in this table's directory. A
	 * nested path such as `todos/a/b.md` is not a row, and neither is `a.MD`.
	 */
	function captureRow(
		capture: FileCapture,
	): Result<FileCapture, Extract<FileError, { name: 'InvalidPath' }>> {
		const own = ownCapture(capture);
		if (own.error) return own;
		if (rowStemOf(name, own.data.path) === undefined)
			return FileError.InvalidPath({
				path: own.data.path,
				reason: `the capture is not a row of '${name}'`,
			});
		return own;
	}

	return {
		name,
		inspect,
		async list() {
			const found = await tableFilenames(storage, name);
			if (found.error) return found;
			// Only the exact lowercase extension is a row; `a.MD` is an ordinary file.
			const rows = found.data.filter((file) => file.endsWith(ROW_EXTENSION));
			const reads = await storage.readMany(
				rows.map((file) => `${name}/${file}`),
			);
			if (reads.error) return Err(reads.error);
			return Ok(
				Object.freeze(
					rows.map((file) => {
						const path = `${name}/${file}`;
						const read = reads.data.get(path);
						if (read === undefined)
							return Object.freeze({
								path,
								result: FileError.Io({
									path,
									operation: 'read',
									cause: 'The storage response omitted this requested file',
								}),
							});
						return Object.freeze({
							path,
							result: read.error
								? Err(read.error)
								: readSnapshot(path, read.data),
						});
					}),
				),
			);
		},
		async get(stem) {
			const address = rowAddress(name, stem);
			if (address.error) return address;
			const read = await storage.read(address.data);
			if (read.error) {
				if (read.error.name === 'NotFound') return Ok(undefined);
				return Err(read.error);
			}
			return readSnapshot(address.data, read.data);
		},
		async create(input) {
			const prepared = prepareRow(parsed, {
				stem: input.stem ?? generateStem(),
				fields: input.fields,
				body: input.body,
			});
			if (prepared.error) return prepared;
			const { path, source, bytes } = prepared.data;
			const vacancy = await vacant(path);
			if (vacancy.error) return vacancy;
			const sha256 = await hashBytes(bytes);
			// The receipt is prepared before anything is published and never after.
			const receipt = snapshotOf(path, sha256, source);
			const applied = await storage.apply([
				{ kind: 'create', path, bytes, sha256 },
			]);
			if (applied.error) return Err(applied.error);
			return Ok(receipt);
		},
		async update(stem, change) {
			const address = rowAddress(name, stem);
			if (address.error) return address;
			const path = address.data;
			// Own the supplied values and body before the first asynchronous read.
			const values = ownValues(parsed, change.fields, false);
			if (values.error) return values;
			const body = change.body;
			const read = await storage.read(path);
			if (read.error) return Err(read.error);
			const source = decode(read.data.bytes);
			if (source === undefined) return TableError.InvalidUtf8({ path });
			const patched = patchSource(source, { fields: values.data, body });
			if (patched.error) {
				const refusal = patched.error;
				if (refusal.kind === 'unparsed')
					return TableError.Unparsed({ path, error: refusal.error });
				if (refusal.kind === 'unsafe')
					return TableError.UnsupportedSource({ path, reason: refusal.reason });
				return TableError.InvalidValues({
					issues: [
						{
							field: refusal.field,
							message: `${refusal.field} cannot be saved: ${refusal.reason}`,
						},
					],
				});
			}
			const next = submitted(patched.data);
			const { bytes } = next;
			const sha256 = await hashBytes(bytes);
			const receipt = snapshotOf(path, sha256, next.source);
			const applied = await storage.apply([
				{
					kind: 'replace',
					path,
					bytes,
					sha256,
					expectedSha256: read.data.sha256,
				},
			]);
			if (applied.error) return Err(applied.error);
			return Ok(receipt);
		},
		async replace(capture, source) {
			const owned = captureRow(capture);
			if (owned.error) return owned;
			const { path, sha256: expectedSha256 } = owned.data;
			const next = submitted(source);
			const { bytes } = next;
			const sha256 = await hashBytes(bytes);
			// The receipt is the submitted text and its hash, never a reread. It is
			// prepared before publication, so returning it needs no further validation.
			const receipt = snapshotOf(path, sha256, next.source);
			const applied = await storage.apply([
				{ kind: 'replace', path, bytes, sha256, expectedSha256 },
			]);
			if (applied.error) return Err(applied.error);
			return Ok(receipt);
		},
		async rename(capture, nextStem) {
			const owned = captureRow(capture);
			if (owned.error) return owned;
			const captured = owned.data;
			// Own the source before the first await, like the path and the hash.
			const supplied: unknown = (capture as Partial<TextCapture>).source;
			if (typeof supplied !== 'string')
				return FileError.InvalidPath({
					path: captured.path,
					reason: 'the capture has no source',
				});
			const address = rowAddress(name, nextStem);
			if (address.error) return address;
			const path = address.data;
			// The receipt reads this source under this hash, so the two must be one
			// capture: the bytes of the source have the captured hash.
			const { bytes, source } = submitted(supplied);
			if ((await hashBytes(bytes)) !== captured.sha256)
				return FileError.InvalidPath({
					path: captured.path,
					reason: "the capture's source does not have its SHA-256",
				});
			const receipt = snapshotOf(path, captured.sha256, source);
			// The row already has this path: nothing is published, and nothing is
			// asked of storage.
			if (path === captured.path) return Ok(receipt);
			const vacancy = await vacant(path);
			if (vacancy.error) return vacancy;
			const applied = await storage.apply([
				{
					kind: 'move',
					from: captured.path,
					to: path,
					expectedSha256: captured.sha256,
				},
			]);
			if (applied.error) return Err(applied.error);
			return Ok(receipt);
		},
		async delete(capture) {
			const owned = captureRow(capture);
			if (owned.error) return owned;
			const captured = owned.data;
			const applied = await storage.apply([
				{
					kind: 'remove',
					path: captured.path,
					expectedSha256: captured.sha256,
				},
			]);
			if (applied.error) return Err(applied.error);
			return Ok(undefined);
		},
	};
}
