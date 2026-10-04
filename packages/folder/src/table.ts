/**
 * File-backed tables: Markdown rows at `<table>/<stem>.md` (ADR-0457, ADR-0462).
 *
 * A snapshot is one captured row file: its literal path and stem, its exact
 * text, the SHA-256 of those bytes, and how that text reads. Reading the
 * file and interpreting its text are separate. A file that was read is a
 * snapshot even when its text does not parse. A parse failure and a field
 * that does not conform are different things: the first leaves no fields or
 * body at all, the second leaves every field that validated.
 *
 * `inspectRow` (`row-text.ts`) is that interpretation by itself, from the
 * table's definition and no open folder. A caller that wants a write's
 * interpretation inspects the receipt's text: a write receipt names the
 * bytes submitted and nothing more.
 *
 * Every mutation addresses its row by stem and takes its options explicitly.
 * `{}` acts on whatever the row holds now; `{ expectedSha256 }` is a
 * condition on the current bytes, checked where the change is published. The
 * hash is a condition on bytes, not an identity or a revision. Structured
 * updates read current text once and always publish against that read;
 * complete replacements read no row while preparing, and the publisher
 * checks any condition against the current bytes. Each publishes once and returns a
 * conflict without retrying (ADR-0464). `edit` is the other save shape: a
 * retained canonical draft of one row whose save overwrites the complete
 * document unconditionally (`editor.ts`).
 *
 * A table reads and writes exactly one Markdown file per row (ADR-0480). A
 * sibling that shares a row's stem is an ordinary file: it is not part of the
 * snapshot, it does not block creating the row, and renaming or deleting the
 * row leaves it where it is.
 */

import type { FieldMap } from '@epicenter/definition';
import { customAlphabet } from 'nanoid';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FolderStorage } from './boundary.js';
import { hashBytes, submittedText } from './capture.js';
import {
	openRowEditor,
	type RowEditor,
	type TableEditError,
} from './editor.js';
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
import { patchRowText } from './markdown.js';
import { ROW_EXTENSION, rowAddressProblem, rowPath } from './paths.js';
import { type DeepReadonly, ownSupplied } from './reading.js';
import {
	composeRowText,
	readRowText,
	type TableReading,
	unrepresentable,
} from './row-text.js';
import { applyOne, reserveSubmission } from './storage.js';

/**
 * One immutable capture of a row file and how its text reads. `text` and
 * `sha256` always describe the same bytes, and the reading is of that text.
 * It is the same repair baseline whether or not the text parses.
 */
export type TableSnapshot<TFields> = TableReading<TFields> & {
	readonly path: string;
	/**
	 * The literal filename without `.md`: `path` is `rowPath(table.name, stem)`.
	 * It may be empty (`<table>/.md`), so never test it by truthiness.
	 */
	readonly stem: string;
	/** The exact text of the whole file, fences and frontmatter included; `body` is only what follows them. */
	readonly text: string;
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

/**
 * What a create, update, or replace submitted: the row's address, the exact
 * text of the whole file sent, and the SHA-256 of its bytes. Nothing is read
 * back, so it says nothing of later changes; `inspectRow(definition.tables.x,
 * receipt.text)` interprets it.
 */
export type TableWriteReceipt = {
	readonly stem: string;
	readonly path: string;
	/** The text of the submitted bytes: an unpaired surrogate was replaced when they were encoded. */
	readonly text: string;
	readonly sha256: string;
};

/**
 * The condition a mutation publishes under, always passed. `{}` acts on
 * whatever the row holds now. `{ expectedSha256: snapshot.sha256 }` acts on
 * the bytes the caller reviewed: the change is refused as `Conflict` unless
 * the row's current bytes still hash to it. The hash is a condition on bytes,
 * not an identity or an acknowledgment: two files with the same text have the
 * same hash.
 *
 * Requiring the argument makes a call site say which it means. It does not
 * make a wrapper forward what it was given: a wrapper that passes `{}` of its
 * own drops its caller's guard, and nothing here can tell. An object with any
 * other enumerable own string key, such as a misspelled `expectedSHA256` or a
 * snapshot passed in place of options, is `InvalidPath` before anything is
 * read. Symbol, inherited, and non-enumerable keys other than the guard are
 * not inspected.
 *
 * `{}` is the only way to say "the current row". An `expectedSha256` that is
 * present but `undefined`, as `{ expectedSha256: snapshot?.sha256 }` makes
 * when there is no snapshot, is `InvalidPath` before anything is read, not
 * an unguarded write. The type cannot refuse it, since the property is
 * optional; the check runs where the call arrives, as the lowercase-hex check
 * does.
 */
export type TableWriteOptions = {
	readonly expectedSha256?: string;
};

export type FileTable<TFields> = {
	readonly name: string;
	/** An outer error means the listing itself failed; no partial listing is returned. */
	list(): Promise<Result<TableListing<TFields>, TableEnumerationError>>;
	/** `undefined` only when no file is at the stem. A file whose text does not parse is still a snapshot. */
	get(
		stem: string,
	): Promise<Result<TableSnapshot<TFields> | undefined, TableGetError>>;
	/**
	 * Save a new row. The text always has both fences, even with no fields
	 * and no body; `serializeRow` previews it. The supplied values are copied,
	 * never frozen or kept.
	 */
	create(input: {
		/** The file stem; generated when omitted. It is not the title. */
		readonly stem?: string;
		readonly fields: DeepReadonly<TFields>;
		readonly body?: string;
	}): Promise<Result<TableWriteReceipt, TableCreateError>>;
	/**
	 * Assign fields/body in the current text, preserving everything else. The
	 * text must parse, for a body change too; other fields may have issues.
	 * With `expectedSha256`, the bytes read must have that hash; a missing row
	 * is then `Conflict`, and `NotFound` without it. The save is always
	 * conditional on the bytes this call read, which is separate from the
	 * caller's guard: a publication race returns Conflict; nothing retries,
	 * and nothing is rewritten on a refusal.
	 */
	update(
		stem: string,
		change: {
			readonly fields?: DeepReadonly<Partial<TFields>>;
			readonly body?: string;
		},
		options: TableWriteOptions,
	): Promise<Result<TableWriteReceipt, TableUpdateError>>;
	/**
	 * Save the complete text of the file over the existing row at `stem`,
	 * exactly as given. The row must exist: a missing row is `NotFound`
	 * unguarded and `Conflict` with `expectedSha256`, and a replacement never
	 * creates a file. Text that does not parse is saved all the same. Nothing
	 * is read before or after.
	 */
	replace(
		stem: string,
		text: string,
		options: TableWriteOptions,
	): Promise<Result<TableWriteReceipt, TableReplaceError>>;
	/**
	 * Move the row file to a vacant stem. No other file moves with it, and
	 * nothing is read or decoded for a reply. A move that landed the new path
	 * but kept the old one is `MoveError.SourceNotRemoved`, as for
	 * `files.move`; it names a hash only when `expectedSha256` guarded it.
	 *
	 * A `nextStem` equal to `stem` is `InvalidPath` before anything is read:
	 * such a move would verify neither the row nor `expectedSha256`, so it is
	 * refused rather than reported as done. Skip the call when the name is
	 * unchanged.
	 */
	rename(
		stem: string,
		nextStem: string,
		options: TableWriteOptions,
	): Promise<Result<undefined, TableRenameError>>;
	/**
	 * Remove the row file. No other file is removed with it. An absent row is
	 * `NotFound`, with or without `expectedSha256`; it does not count as done.
	 * Present bytes that differ from `expectedSha256` are `Conflict`.
	 */
	delete(
		stem: string,
		options: TableWriteOptions,
	): Promise<Result<undefined, TableDeleteError>>;
	/**
	 * Open a retained editor on the row at `stem`. It subscribes to change
	 * hints, then reads once. It opens only a file that has a canonical form
	 * and whose declared fields conform; a refusal carries the exact text
	 * when there is one, for raw repair. `signal` governs opening only: once
	 * the editor is returned, the caller owns it and ends it with `dispose`.
	 */
	edit(
		stem: string,
		options?: { readonly signal?: AbortSignal },
	): Promise<Result<RowEditor<TFields>, TableEditError>>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const generateStem = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 10);

function decode(bytes: Uint8Array): string | undefined {
	try {
		return utf8.decode(bytes);
	} catch {
		return undefined;
	}
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
 * The caller's options, owned before anything is awaited: the guard is read
 * once, so a getter cannot answer differently later. Options are required
 * and hold nothing but the guard. Absent options, or an object with another
 * enumerable own string key (a misspelled guard, or a snapshot passed where
 * options go), would otherwise publish unguarded, so they are refused.
 *
 * Only an absent `expectedSha256` acts on the current row. A present one,
 * own or inherited, must be a lowercase SHA-256: `undefined` there is a
 * guard that went missing on its way here, such as `{ expectedSha256:
 * snapshot?.sha256 }`, and is refused rather than published unguarded. The
 * type allows `undefined` in the property; this check is what refuses it.
 */
function ownExpected(
	path: string,
	options: TableWriteOptions,
): Result<string | undefined, Extract<FileError, { name: 'InvalidPath' }>> {
	const supplied: unknown = options;
	if (
		typeof supplied !== 'object' ||
		supplied === null ||
		Array.isArray(supplied)
	)
		return FileError.InvalidPath({
			path,
			reason:
				'Write options are required: pass {} to act on the current row, or { expectedSha256 } to act on reviewed bytes',
		});
	const unknown = Object.keys(supplied).find((key) => key !== 'expectedSha256');
	if (unknown !== undefined)
		return FileError.InvalidPath({
			path,
			reason: `Write options take only expectedSha256, not '${unknown}'`,
		});
	// Presence is decided before the value is read, and the value read once.
	if (!('expectedSha256' in supplied)) return Ok(undefined);
	const expected: unknown = (supplied as TableWriteOptions).expectedSha256;
	if (expected === undefined)
		return FileError.InvalidPath({
			path,
			reason:
				'expectedSha256 is present but undefined: omit it, or pass {}, to act on the current row',
		});
	if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected))
		return FileError.InvalidPath({
			path,
			reason: 'expectedSha256 is not a lowercase SHA-256',
		});
	return Ok(expected);
}

/**
 * Supplied values as the table will save them: the table's own frozen
 * copies, checked against its prepared fields and known to be writable as
 * YAML. Synchronous, so it finishes before anything is read.
 */
function ownValues(
	schemas: FieldMap,
	supplied: unknown,
	complete: boolean,
): Result<
	Record<string, unknown>,
	Extract<TableError, { name: 'InvalidValues' }>
> {
	const { values, issues } = ownSupplied(
		schemas,
		(supplied ?? {}) as Record<string, unknown>,
		{ complete },
	);
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	issues.push(...unrepresentable(values));
	if (issues.length > 0) return TableError.InvalidValues({ issues });
	return Ok(values);
}

/** The exact file a new row is: its path, its text, and that text's bytes. */
type PreparedRow = {
	readonly path: string;
	readonly text: string;
	readonly bytes: Uint8Array;
};

/**
 * Validate and serialize a new row. Synchronous: it reads nothing.
 *
 * `name` is the table's key in the prepared definition, which is the only
 * place a table is named, and `schemas` are that table's prepared fields.
 */
function prepareRow(
	name: string,
	schemas: FieldMap,
	input: {
		readonly stem: string;
		readonly fields: unknown;
		readonly body?: string;
	},
): Result<
	PreparedRow,
	Extract<TableCreateError, { name: 'InvalidPath' | 'InvalidValues' }>
> {
	const { data: path, error: addressError } = rowAddress(name, input.stem);
	if (addressError !== null) return Err(addressError);
	const { data: values, error: valuesError } = ownValues(
		schemas,
		input.fields,
		true,
	);
	if (valuesError !== null) return Err(valuesError);
	const { data: text, error: composeError } = composeRowText(
		schemas,
		values,
		input.body ?? '',
	);
	if (composeError !== null) return Err(composeError);
	return Ok({ path, ...submittedText(text) });
}

/** The filenames directly in a table's directory; none when it does not exist yet. */
async function tableFilenames(
	storage: Pick<FolderStorage, 'children'>,
	table: string,
): Promise<Result<string[], TableEnumerationError>> {
	const { data: children, error: childrenError } =
		await storage.children(table);
	if (childrenError !== null) {
		if (childrenError.name === 'NotFound') return Ok([]);
		return Err(childrenError);
	}
	return Ok(children.files);
}

/**
 * The file table for one declared table. `name` is its key in the prepared
 * definition and its directory; `schemas` are its prepared fields, in
 * declared order. `onFilesChanged` is the folder's change hints, which an
 * editor watches.
 */
export function createTable<TFields>(
	{
		storage,
		onFilesChanged,
	}: {
		storage: FolderStorage;
		onFilesChanged: (
			listener: (paths: readonly string[]) => void,
		) => () => void;
	},
	name: string,
	schemas: FieldMap,
): FileTable<TFields> {
	const inspect = (text: string) => readRowText<TFields>(schemas, text);
	const declaredKeys = Object.freeze(Object.keys(schemas));

	const stemOf = (path: string) =>
		path.slice(name.length + 1, -ROW_EXTENSION.length);

	/** The snapshot of bytes that were read. */
	function snapshotOf(
		path: string,
		sha256: string,
		text: string,
	): TableSnapshot<TFields> {
		return Object.freeze({
			path,
			stem: stemOf(path),
			sha256,
			text,
			...inspect(text),
		});
	}

	/** The receipt of bytes about to be submitted, prepared before publication and never after. */
	function receiptOf(
		path: string,
		sha256: string,
		text: string,
	): TableWriteReceipt {
		return Object.freeze({ stem: stemOf(path), path, text, sha256 });
	}

	/** Interpret the bytes of one read, or say why they are not text. */
	function readSnapshot(
		path: string,
		read: { bytes: Uint8Array; sha256: string },
	): Result<
		TableSnapshot<TFields>,
		Extract<TableError, { name: 'InvalidUtf8' }>
	> {
		const text = decode(read.bytes);
		if (text === undefined)
			return TableError.InvalidUtf8({ path, sha256: read.sha256 });
		return Ok(snapshotOf(path, read.sha256, text));
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
		const { data: filenames, error: listError } = await tableFilenames(
			storage,
			name,
		);
		if (listError !== null) return Err(listError);
		if (filenames.includes(path.slice(name.length + 1)))
			return FileError.Exists({ path });
		return Ok(undefined);
	}

	return {
		name,
		async list() {
			const { data: filenames, error: listError } = await tableFilenames(
				storage,
				name,
			);
			if (listError !== null) return Err(listError);
			// Only the exact lowercase extension is a row; `a.MD` is an ordinary file.
			const rows = filenames.filter((file) => file.endsWith(ROW_EXTENSION));
			const { data: reads, error: readsError } = await storage.readMany(
				rows.map((file) => `${name}/${file}`),
			);
			if (readsError !== null) return Err(readsError);
			return Ok(
				Object.freeze(
					rows.map((file) => {
						const path = `${name}/${file}`;
						const outcome = reads.get(path);
						if (outcome === undefined)
							return Object.freeze({
								path,
								result: FileError.Io({
									path,
									operation: 'read',
									cause: 'The storage response omitted this requested file',
								}),
							});
						const { data: read, error: readError } = outcome;
						return Object.freeze({
							path,
							result:
								readError !== null ? Err(readError) : readSnapshot(path, read),
						});
					}),
				),
			);
		},
		async get(stem) {
			const { data: path, error: addressError } = rowAddress(name, stem);
			if (addressError !== null) return Err(addressError);
			const { data: read, error: readError } = await storage.read(path);
			if (readError !== null) {
				if (readError.name === 'NotFound') return Ok(undefined);
				return Err(readError);
			}
			return readSnapshot(path, read);
		},
		async create(input) {
			// Every save reserves its place first, before its reads and hash.
			const submission = reserveSubmission();
			const { data: prepared, error: prepareError } = prepareRow(
				name,
				schemas,
				{
					stem: input.stem ?? generateStem(),
					fields: input.fields,
					body: input.body,
				},
			);
			if (prepareError !== null) return Err(prepareError);
			const { path, text, bytes } = prepared;
			const vacancy = await vacant(path);
			if (vacancy.error !== null) return vacancy;
			const sha256 = await hashBytes(bytes);
			const receipt = receiptOf(path, sha256, text);
			const { error: applyError } = await applyOne(
				storage,
				{ kind: 'create', path, bytes, sha256 },
				submission,
			);
			if (applyError !== null) return Err(applyError);
			return Ok(receipt);
		},
		async update(stem, change, options) {
			const submission = reserveSubmission();
			const { data: path, error: addressError } = rowAddress(name, stem);
			if (addressError !== null) return Err(addressError);
			// Own the baseline, the supplied values, and the body before the
			// first asynchronous read.
			const { data: expected, error: expectedError } = ownExpected(
				path,
				options,
			);
			if (expectedError !== null) return Err(expectedError);
			const { data: values, error: valuesError } = ownValues(
				schemas,
				change.fields,
				false,
			);
			if (valuesError !== null) return Err(valuesError);
			const body = change.body;
			const { data: read, error: readError } = await storage.read(path);
			if (readError !== null) {
				// An absent row does not have the caller's bytes either.
				if (readError.name === 'NotFound' && expected !== undefined)
					return FileError.Conflict({
						path,
						expectedSha256: expected,
						actualSha256: undefined,
					});
				return Err(readError);
			}
			if (expected !== undefined && read.sha256 !== expected)
				return FileError.Conflict({
					path,
					expectedSha256: expected,
					actualSha256: read.sha256,
				});
			const text = decode(read.bytes);
			if (text === undefined)
				return TableError.InvalidUtf8({ path, sha256: read.sha256 });
			const { data: patched, error: refusal } = patchRowText(text, {
				fields: values,
				body,
			});
			if (refusal !== null) {
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
			const next = submittedText(patched);
			const { bytes } = next;
			const sha256 = await hashBytes(bytes);
			const receipt = receiptOf(path, sha256, next.text);
			// Published against this call's own read, whether or not the caller
			// named a baseline: the patch is of exactly those bytes.
			const { error: applyError } = await applyOne(
				storage,
				{
					kind: 'replace',
					path,
					bytes,
					sha256,
					expectedSha256: read.sha256,
				},
				submission,
			);
			if (applyError !== null) return Err(applyError);
			return Ok(receipt);
		},
		async replace(stem, text, options) {
			const submission = reserveSubmission();
			const { data: path, error: addressError } = rowAddress(name, stem);
			if (addressError !== null) return Err(addressError);
			const { data: expectedSha256, error: expectedError } = ownExpected(
				path,
				options,
			);
			if (expectedError !== null) return Err(expectedError);
			const next = submittedText(text);
			const { bytes } = next;
			const sha256 = await hashBytes(bytes);
			// The receipt is the submitted text and its hash, never a reread.
			const receipt = receiptOf(path, sha256, next.text);
			// A replacement requires an existing row at the storage that
			// publishes it, guarded or not; it is never an overwrite.
			const { error: applyError } = await applyOne(
				storage,
				{ kind: 'replace', path, bytes, sha256, expectedSha256 },
				submission,
			);
			if (applyError !== null) return Err(applyError);
			return Ok(receipt);
		},
		async rename(stem, nextStem, options) {
			const submission = reserveSubmission();
			const { data: from, error: fromError } = rowAddress(name, stem);
			if (fromError !== null) return Err(fromError);
			const { data: to, error: toError } = rowAddress(name, nextStem);
			if (toError !== null) return Err(toError);
			const { data: expectedSha256, error: expectedError } = ownExpected(
				from,
				options,
			);
			if (expectedError !== null) return Err(expectedError);
			// A move to its own path would check neither the row nor the
			// baseline, so success would claim what nothing verified.
			if (to === from)
				return FileError.InvalidPath({
					path: to,
					reason: 'A row cannot be renamed to the stem it already has',
				});
			const vacancy = await vacant(to);
			if (vacancy.error !== null) return vacancy;
			return applyOne(
				storage,
				{ kind: 'move', from, to, expectedSha256 },
				submission,
			);
		},
		async delete(stem, options) {
			const submission = reserveSubmission();
			const { data: path, error: addressError } = rowAddress(name, stem);
			if (addressError !== null) return Err(addressError);
			const { data: expectedSha256, error: expectedError } = ownExpected(
				path,
				options,
			);
			if (expectedError !== null) return Err(expectedError);
			return applyOne(
				storage,
				{ kind: 'remove', path, expectedSha256 },
				submission,
			);
		},
		async edit(stem, options) {
			const { data: path, error: addressError } = rowAddress(name, stem);
			if (addressError !== null) return Err(addressError);
			return openRowEditor<TFields>(
				{
					path,
					storage,
					onFilesChanged,
					declaredKeys,
					inspect,
				},
				options?.signal,
			);
		},
	};
}
