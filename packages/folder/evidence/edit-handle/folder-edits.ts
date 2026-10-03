/**
 * EXPERIMENT: bind the edit handle to a folder's table rows and text files.
 *
 *     const edits = createFolderEdits(folder);
 *     const edit = edits.tables.todos.edit(displayedSnapshot);
 *     const notes = edits.files.edit(textCapture);
 *     const saved = await edits.tables.todos.save(displayed, { fields: { done } });
 *
 * Each `edit()` call opens a fresh handle. Controls that should share one
 * draft share that handle explicitly; there is no registry that hands two
 * callers the same draft for one path. A one-click control needs no handle:
 * `save` is a single conditional operation with no lifecycle.
 *
 * `folder` is anything with the few `Folder` members used here: a real
 * folder from `@epicenter/folder/bun`, or the demo's HTTP facade.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TextCapture } from '../../src/capture.js';
import {
	FileError,
	TableError,
	type TableReplaceError,
} from '../../src/errors.js';
import type { FolderFiles } from '../../src/files.js';
import { type PatchRefusal, patchSource } from '../../src/markdown.js';
import { rowPath } from '../../src/paths.js';
import type { FileTable } from '../../src/table.js';
import {
	createEditHandle,
	type EditDocument,
	type EditRefusal,
	type Observation,
} from './edit-handle.js';

/** The table members an edit reads and saves through. */
export type EditableTable = Pick<
	FileTable<object>,
	'inspect' | 'get' | 'replace'
>;

/** The folder members an edit reads and saves through. */
export type EditableFolder<TTables extends Record<string, EditableTable>> = {
	readonly tables: TTables;
	readonly files: Pick<FolderFiles, 'read' | 'replace'>;
	onFilesChanged(listener: (paths: readonly string[]) => void): () => void;
};

/** A row snapshot of this table, derived from what its `get` returns. */
export type SnapshotOf<TTable extends EditableTable> = NonNullable<
	Awaited<ReturnType<TTable['get']>>['data']
>;
export type ReadingOf<TTable extends EditableTable> = ReturnType<
	TTable['inspect']
>;

/** A one-shot save's refusals: the change did not fit the source, or publication failed. */
export type OneShotSaveError =
	| Extract<
			TableError,
			{ name: 'Unparsed' | 'UnsupportedSource' | 'InvalidValues' }
	  >
	| TableReplaceError;

/** A patch refusal as the table error `update` reports for the same source. */
function refusalError(path: string, refusal: PatchRefusal) {
	switch (refusal.kind) {
		case 'unparsed':
			return TableError.Unparsed({ path, error: refusal.error });
		case 'unsafe':
			return TableError.UnsupportedSource({ path, reason: refusal.reason });
		case 'value':
			return TableError.InvalidValues({
				issues: [
					{
						field: refusal.field,
						message: `${refusal.field} cannot be saved: ${refusal.reason}`,
					},
				],
			});
	}
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function createFolderEdits<
	TTables extends Record<string, EditableTable>,
>(folder: EditableFolder<TTables>) {
	function watchPath(path: string) {
		return (onChange: () => void) =>
			folder.onFilesChanged((paths) => {
				if (paths.includes(path)) onChange();
			});
	}

	function tableEdits<TTable extends EditableTable>(
		name: string,
		table: TTable,
	) {
		type Snapshot = SnapshotOf<TTable>;
		type Reading = ReadingOf<TTable>;
		type Change = {
			readonly fields?: Reading['fields'];
			readonly body?: string;
		};
		const prepare = (source: string, change: Change) =>
			patchSource(source, {
				fields: change.fields as Readonly<Record<string, unknown>> | undefined,
				body: change.body,
			});
		/** Whether a snapshot is a row of this table: its path is its stem's row path. */
		const isRow = (snapshot: Snapshot) =>
			snapshot.path === rowPath(name, snapshot.stem);

		return {
			/**
			 * Save one change to the row as displayed, once, with no handle and
			 * nothing to dispose. It patches exactly `displayed.source`, keeping
			 * every other byte, and replaces the file only if it is still that
			 * version. A change the source cannot take is refused before anything
			 * is written. Nothing retries; an `Unconfirmed` result stays unknown.
			 */
			async save(
				displayed: Snapshot,
				change: Change,
			): Promise<Result<Snapshot, OneShotSaveError>> {
				if (!isRow(displayed))
					return FileError.InvalidPath({
						path: displayed.path,
						reason: `the snapshot is not a row of '${name}'`,
					});
				const prepared = prepare(displayed.source, change);
				if (prepared.error) return refusalError(displayed.path, prepared.error);
				return (await table.replace(displayed, prepared.data)) as Result<
					Snapshot,
					TableReplaceError
				>;
			},
			/** Open a fresh handle on the row the caller displays. */
			edit(displayed: Snapshot) {
				if (!isRow(displayed))
					throw new TypeError(
						`'${displayed.path}' is not a row of '${name}'; open it from its own table`,
					);
				const document: EditDocument<Snapshot, Reading> = {
					path: displayed.path,
					interpret: (source) => table.inspect(source) as Reading,
					async read(): Promise<Observation<Snapshot>> {
						const got = await table.get(displayed.stem);
						if (got.error) return { kind: 'unreadable', error: got.error };
						if (got.data === undefined) return { kind: 'missing' };
						return { kind: 'present', snapshot: got.data as Snapshot };
					},
					save: async (baseline, source) =>
						(await table.replace(baseline, source)) as Result<
							Snapshot,
							TableReplaceError
						>,
					watch: watchPath(displayed.path),
				};
				const handle = createEditHandle(document, displayed);
				return {
					...handle,
					/**
					 * Prepare a new candidate from the current one: assign fields and
					 * the body in its source, preserving every other byte. A candidate
					 * that does not parse, or cannot take the change safely, is
					 * refused and left exactly as it was.
					 */
					change(
						change: Change,
					): Result<undefined, PatchRefusal | EditRefusal> {
						if (handle.get().isDisposed)
							return Err({ kind: 'refused', reason: 'disposed' });
						const prepared = prepare(handle.get().source, change);
						if (prepared.error) return prepared;
						return handle.input(prepared.data);
					},
				};
			},
		};
	}

	const tables = Object.fromEntries(
		Object.entries(folder.tables).map(([name, table]) => [
			name,
			tableEdits(name, table),
		]),
	) as {
		readonly [K in keyof TTables]: ReturnType<typeof tableEdits<TTables[K]>>;
	};

	return {
		tables,
		files: {
			/** Open a fresh handle on a UTF-8 text file the caller displays. */
			edit(displayed: TextCapture) {
				const { path } = displayed;
				const document: EditDocument<TextCapture, undefined> = {
					path,
					interpret: () => undefined,
					async read() {
						const read = await folder.files.read(path);
						if (read.error) {
							if (read.error.name === 'NotFound') return { kind: 'missing' };
							return { kind: 'unreadable', error: read.error };
						}
						let source: string;
						try {
							source = utf8.decode(read.data.bytes);
						} catch {
							return {
								kind: 'unreadable',
								error: TableError.InvalidUtf8({ path }).error,
							};
						}
						return {
							kind: 'present',
							snapshot: Object.freeze({
								path,
								sha256: read.data.sha256,
								source,
							}),
						};
					},
					async save(baseline, source) {
						// The receipt is the text of the submitted bytes, as a table's is.
						const bytes = encoder.encode(source);
						const saved = await folder.files.replace(baseline, bytes);
						if (saved.error) return saved;
						return Ok(
							Object.freeze({
								path,
								sha256: saved.data.sha256,
								source: utf8.decode(bytes),
							}),
						);
					},
					watch: watchPath(path),
				};
				return createEditHandle(document, displayed);
			},
		},
	};
}

export type FolderEdits<TTables extends Record<string, EditableTable>> =
	ReturnType<typeof createFolderEdits<TTables>>;
