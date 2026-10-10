/**
 * Read a data folder on disk without opening it (ADR-0517).
 *
 * A data folder is a directory holding `epicenter.json`. `readFolder` reads
 * and prepares that declaration, then reads every declared table and
 * `kv.json` through the same tables, settings, and native file boundary an
 * opened folder uses, so a tool and an application reach the same verdict
 * on every file: path policy, symbolic links, names, UTF-8, and row
 * validity included.
 *
 * It writes nothing. It takes no lock, leaves no marker, initializes no Git
 * repository, publishes no declaration, and loads no native addon, so it can
 * read a folder an application has open, or one nested in any repository.
 */

import { lstat, realpath } from 'node:fs/promises';
import { exportSchema } from '@epicenter/definition';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import {
	type FolderDefinition,
	type PreparedFolderTable,
	prepareFolderDefinition,
} from './definition.js';
import {
	FileError,
	type KvReadError,
	type TableEnumerationError,
} from './errors.js';
import { createKv, type KvReading } from './kv.js';
import { createNativeFileBoundary } from './native-store.js';
import { DECLARATION_PATH } from './paths.js';
import { createTable, type TableListing } from './table.js';

export const ReadFolderError = defineErrors({
	/** The directory has no `epicenter.json`, so it is not a data folder. */
	NotDataFolder: ({ root }: { root: string }) => ({
		message: `'${root}' is not a data folder: it has no ${DECLARATION_PATH}`,
		root,
	}),
	/**
	 * `epicenter.json` is not a readable file, is not UTF-8 JSON, has a
	 * top-level key other than `title`, `kv`, `tables`, or `$schema`, or
	 * declares something an opener could not have published.
	 */
	InvalidDeclaration: ({ root, reason }: { root: string; reason: string }) => ({
		message: `'${root}/${DECLARATION_PATH}' cannot be used: ${reason}`,
		root,
		reason,
	}),
});
export type ReadFolderError = InferErrors<typeof ReadFolderError>;

/** What a data folder holds, read once. */
export type FolderReading = {
	/** The directory read, as the caller named it. */
	readonly root: string;
	/** The prepared declaration from `epicenter.json`. */
	readonly definition: FolderDefinition;
	/** Exactly what each declared table's `list()` returns. */
	readonly tables: Readonly<
		Record<
			string,
			Result<TableListing<Record<string, unknown>>, TableEnumerationError>
		>
	>;
	/** Exactly what `kv.get()` returns. */
	readonly kv: Result<
		KvReading<Record<string, unknown>> | undefined,
		KvReadError
	>;
};

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** `$schema` lets an editor offer completion; it is not interpreted. */
const DECLARATION_KEYS = new Set(['title', 'kv', 'tables', '$schema']);

/**
 * Read the data folder at `root`. A directory with no `epicenter.json` is
 * `NotDataFolder`; one whose declaration cannot be used is
 * `InvalidDeclaration`; a missing root is `NotFound`, and a root that is not a directory is
 * `NotADirectory`. A
 * table or `kv.json` that cannot be read is that entry's error, beside the
 * others.
 */
export async function readFolder(
	root: string,
): Promise<Result<FolderReading, ReadFolderError | FileError>> {
	let resolved: string;
	try {
		resolved = await realpath(root);
		if (!(await lstat(resolved)).isDirectory())
			return FileError.NotADirectory({ path: root });
	} catch (cause) {
		return (cause as NodeJS.ErrnoException).code === 'ENOENT'
			? FileError.NotFound({ path: root })
			: FileError.Io({ path: root, operation: 'open', cause });
	}
	const storage = createNativeFileBoundary(resolved);

	const { data: read, error: readError } = await storage.read(DECLARATION_PATH);
	if (readError !== null)
		return readError.name === 'NotFound'
			? ReadFolderError.NotDataFolder({ root })
			: ReadFolderError.InvalidDeclaration({
					root,
					reason: readError.message,
				});
	let declared: unknown;
	try {
		declared = JSON.parse(utf8.decode(read.bytes));
	} catch (cause) {
		return ReadFolderError.InvalidDeclaration({
			root,
			reason: `it is not UTF-8 JSON (${cause instanceof Error ? cause.message : String(cause)})`,
		});
	}
	if (
		declared === null ||
		typeof declared !== 'object' ||
		Array.isArray(declared)
	)
		return ReadFolderError.InvalidDeclaration({
			root,
			reason: 'it is not a JSON object',
		});
	// A misspelled top-level key would otherwise read as an empty declaration.
	const unknown = Object.keys(declared).filter(
		(key) => !DECLARATION_KEYS.has(key),
	);
	if (unknown.length > 0)
		return ReadFolderError.InvalidDeclaration({
			root,
			reason: `unknown top-level key ${unknown.map((key) => `'${key}'`).join(', ')}; expected title, kv, tables, or $schema`,
		});
	const { $schema: _editorHint, ...described } = declared as Record<
		string,
		unknown
	>;
	// prepareFolderDefinition checks the parsed value at runtime.
	const { data: definition, error: definitionError } = prepareFolderDefinition(
		described as FolderDefinition,
	);
	if (definitionError !== null)
		return ReadFolderError.InvalidDeclaration({
			root,
			reason: definitionError.reason,
		});
	// epicenter.json is what exportSchema writes (ADR-0517), so a declaration
	// it refuses, such as an unknown format, could not have been published.
	const { error: exportError } = exportSchema(definition);
	if (exportError !== null)
		return ReadFolderError.InvalidDeclaration({
			root,
			reason:
				exportError.cause instanceof Error
					? exportError.cause.message.replace(/^\$\./, '')
					: exportError.message,
		});

	const tables: Record<
		string,
		Result<TableListing<Record<string, unknown>>, TableEnumerationError>
	> = {};
	// prepareFolderDefinition refused body conversions, which JSON cannot carry.
	for (const [name, table] of Object.entries(definition.tables))
		tables[name] = await createTable<Record<string, unknown>>(
			{ storage },
			name,
			table as PreparedFolderTable,
		).list();
	const kv = await createKv<Record<string, unknown>>(
		{ storage },
		definition.kv,
	).get();

	return Ok(
		Object.freeze({
			root,
			definition,
			tables: Object.freeze(tables),
			kv,
		}),
	);
}
