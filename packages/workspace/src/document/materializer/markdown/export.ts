import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Type } from 'typebox';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import { defineActions, defineMutation } from '../../../shared/actions.js';
import type { MaybePromise } from '../../../shared/types.js';
import type { BaseRow, Table } from '../../table.js';
import type { AnyTable, TablesRecord } from '../shared.js';
import {
	assembleMarkdown,
	type FileState,
	type MarkdownShape,
	materializeTable,
	type RenderRow,
	rebuildTable,
} from './shared.js';

// ════════════════════════════════════════════════════════════════════════════
// attachMarkdownExport: the read-only markdown projection
//
// A continuously-materialized, ONE-WAY Yjs → disk view with free serialization:
// custom filenames (slugs), custom `toMarkdown` (layouts, publish transforms),
// per-table subdirectories. There is no `apply`: this projection is never read
// back, so it carries no round-trip obligation and can shape the output however a
// human-readable export or a published site wants. The editable, reconciled seam
// is `attachMarkdownVault`; the sqlite materializer is the read-only sibling for
// a relational projection.
// ════════════════════════════════════════════════════════════════════════════

/** Per-table customization for the read-only export. Every field is optional. */
export type ExportTableConfig<TRow extends BaseRow> = {
	/** Subdirectory (joined onto the base `dir`) for this table. Default: `table.name`. */
	dir?: string;
	/** Compute the on-disk filename for a row. Default: `${row.id}.md`. */
	filename?: (row: TRow) => MaybePromise<string>;
	/** Produce frontmatter + body for a row. Default: `{ frontmatter: row, body: undefined }`. */
	toMarkdown?: (row: TRow) => MaybePromise<MarkdownShape>;
};

/**
 * Mapped per-table config keyed by `workspace.tables` name. Presence is the
 * selection: only tables named here are exported.
 */
export type ExportTablesConfig<TTables extends TablesRecord> = {
	[K in keyof TTables]?: TTables[K] extends Table<infer TRow>
		? ExportTableConfig<TRow>
		: never;
};

type RegisteredTable = {
	table: AnyTable;
	// biome-ignore lint/suspicious/noExplicitAny: internal storage, variance across heterogeneous row types
	config: ExportTableConfig<any>;
	fileState: FileState;
	render: RenderRow;
	subdir: string;
	unsubscribe?: () => void;
};

/**
 * Attach a read-only markdown export to a workspace. Continuously materializes
 * the selected tables to disk with caller-controlled serialization, and exposes
 * a single `markdown_rebuild` mutation for a destructive full re-export (orphan
 * cleanup after a filename/layout change). There is no import path.
 */
export function attachMarkdownExport<TTables extends TablesRecord>(
	workspace: { ydoc: Y.Doc; tables: TTables },
	{
		dir,
		perTable,
		waitFor,
		log = createLogger('markdown-export'),
	}: {
		/** Base output directory. A string or async getter for lazy path resolution. */
		dir: string | (() => MaybePromise<string>);
		/**
		 * Per-table customization keyed by `workspace.tables` name. Presence selects:
		 * only tables named here are exported. Pass `{}` for an entry to export with
		 * all defaults.
		 */
		perTable?: ExportTablesConfig<TTables>;
		/** Gate: awaited before the initial filesystem flush. Omit for no gate. */
		waitFor?: Promise<unknown>;
		/** Logger for background write-observer failures. */
		log?: Logger;
	},
) {
	const { ydoc, tables } = workspace;
	const registered = new Map<string, RegisteredTable>();
	for (const [name, table] of Object.entries(tables)) {
		const config = (
			perTable as Record<string, ExportTableConfig<BaseRow>> | undefined
		)?.[name];
		if (config === undefined) continue;
		const anyTable = table as AnyTable;
		const render: RenderRow = async (row) => {
			const shape = config.toMarkdown
				? await config.toMarkdown(row)
				: { frontmatter: { ...row }, body: undefined };
			const filename = config.filename
				? await config.filename(row)
				: `${row.id}.md`;
			return { filename, content: assembleMarkdown(shape.frontmatter, shape.body) };
		};
		registered.set(name, {
			table: anyTable,
			config,
			fileState: new Map(),
			render,
			subdir: config.dir ?? name,
		});
	}
	let isDisposed = false;

	const resolveDir = async () =>
		typeof dir === 'function' ? await dir() : dir;

	function dispose() {
		if (isDisposed) return;
		isDisposed = true;
		for (const entry of registered.values()) entry.unsubscribe?.();
	}

	ydoc.once('destroy', dispose);

	async function initialize() {
		await waitFor;
		if (isDisposed) return;

		const baseDir = await resolveDir();
		await mkdir(baseDir, { recursive: true });

		for (const entry of registered.values()) {
			if (isDisposed) return;
			entry.unsubscribe = await materializeTable({
				table: entry.table,
				directory: join(baseDir, entry.subdir),
				render: entry.render,
				fileState: entry.fileState,
				log,
			});
		}
	}

	const whenFlushed = initialize();

	async function rebuildMarkdownFiles(
		tableName?: string,
	): Promise<{ deleted: number; written: number }> {
		const baseDir = await resolveDir();

		async function rebuildOne(entry: RegisteredTable) {
			return rebuildTable({
				table: entry.table,
				directory: join(baseDir, entry.subdir),
				render: entry.render,
				fileState: entry.fileState,
			});
		}

		if (tableName !== undefined) {
			const entry = registered.get(tableName);
			if (entry === undefined) {
				throw new Error(
					`Cannot rebuild "${tableName}": not in the export's table set.`,
				);
			}
			return rebuildOne(entry);
		}

		let deleted = 0;
		let written = 0;
		for (const entry of registered.values()) {
			const r = await rebuildOne(entry);
			deleted += r.deleted;
			written += r.written;
		}
		return { deleted, written };
	}

	return {
		whenFlushed,
		actions: defineActions({
			markdown_rebuild: defineMutation({
				title: 'Rebuild Markdown Export',
				description:
					'Destructive: delete existing .md files in registered table directories and re-serialize all valid rows. Optionally limit to one table.',
				input: Type.Object({
					tableName: Type.Optional(
						Type.String({
							description:
								'Limit rebuild to one registered table; omit for all tables.',
						}),
					),
				}),
				handler: ({ tableName }) => rebuildMarkdownFiles(tableName),
			}),
		}),
	};
}

export type MarkdownExport = ReturnType<typeof attachMarkdownExport>;
