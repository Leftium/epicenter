/**
 * `epicenter check` and `epicenter query` (ADR-0520). Both read a data folder's
 * `epicenter.json`, parse every declared row with the folder package's
 * `parseRow`, and interpret `kv.json`. `check` reports what does not conform;
 * `query` answers one read-only SQL statement over an in-memory projection
 * (ADR-0494). Nothing here writes a file, executes the folder's code, reads
 * Git, or contacts a network.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fieldEditorOf } from '../packages/definition/src/index.js';
import {
	type FolderDefinition,
	type PreparedFolderTable,
	prepareFolderDefinition,
} from '../packages/folder/src/definition.js';
import { inspectKv } from '../packages/folder/src/kv.js';
import { parseRow } from '../packages/folder/src/row-text.js';

export const DECLARATION = 'epicenter.json';

/** One finding, located as precisely as the source allows. */
export type Diagnostic = {
	path: string;
	line?: number;
	field?: string;
	message: string;
};

type ProjectedRow = {
	id: string;
	path: string;
	sha256: string;
	fields: Record<string, unknown>;
	body: string;
};

type InvalidRow = Diagnostic & { table?: string; sha256?: string };

/** A data folder read whole: what conforms, what does not, and what could not be read. */
export type DataFolderReading = {
	root: string;
	definition: FolderDefinition;
	tables: {
		name: string;
		fields: { name: string; schema: object }[];
		rows: ProjectedRow[];
	}[];
	kv: { key: string; value: unknown }[];
	invalid: InvalidRow[];
	unreadable: Diagnostic[];
};

const decoder = new TextDecoder('utf-8', { fatal: true });

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown) {
	return (error as { code?: unknown } | null)?.code;
}

/**
 * Read `<dir>/epicenter.json` and every row it declares. A declaration that
 * cannot be read or prepared is the error; every later problem is recorded in
 * the reading, so one bad row never hides the rest.
 */
export async function readDataFolder(
	dir: string,
): Promise<
	{ data: DataFolderReading; error: null } | { data: null; error: Diagnostic }
> {
	const root = resolve(dir);
	let declared: unknown;
	try {
		declared = JSON.parse(
			decoder.decode(await readFile(join(root, DECLARATION))),
		);
	} catch (error) {
		return {
			data: null,
			error: {
				path: DECLARATION,
				message:
					codeOf(error) === 'ENOENT'
						? `${root} is not a data folder: it has no ${DECLARATION}`
						: messageOf(error),
			},
		};
	}
	const { data: definition, error: definitionError } = prepareFolderDefinition(
		declared as FolderDefinition,
	);
	if (definitionError !== null)
		return {
			data: null,
			error: { path: DECLARATION, message: definitionError.reason },
		};

	const reading: DataFolderReading = {
		root,
		definition,
		tables: [],
		kv: [],
		invalid: [],
		unreadable: [],
	};

	try {
		const { values, parseError, issues } = inspectKv<Record<string, unknown>>(
			definition.kv,
			decoder.decode(await readFile(join(root, 'kv.json'))),
		);
		if (parseError)
			reading.invalid.push({ path: 'kv.json', message: parseError.message });
		for (const { field, message } of issues)
			reading.invalid.push({ path: 'kv.json', field, message });
		for (const [key, value] of Object.entries(values))
			reading.kv.push({ key, value });
	} catch (error) {
		// No kv.json means no stored settings, the same as an empty object.
		if (codeOf(error) !== 'ENOENT')
			reading.unreadable.push({ path: 'kv.json', message: messageOf(error) });
	}

	for (const [name, table] of Object.entries(definition.tables)) {
		const projected = {
			name,
			fields: Object.entries(table.fields).map(([name, schema]) => ({
				name,
				schema,
			})),
			rows: [] as ProjectedRow[],
		};
		reading.tables.push(projected);
		let files: string[];
		try {
			files = (await readdir(join(root, name), { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
				.map((entry) => entry.name)
				.sort();
		} catch (error) {
			// A declared table with no directory has no rows yet.
			if (codeOf(error) !== 'ENOENT')
				reading.unreadable.push({ path: name, message: messageOf(error) });
			continue;
		}
		for (const file of files) {
			const path = `${name}/${file}`;
			let bytes: Uint8Array;
			let text: string;
			try {
				bytes = await readFile(join(root, path));
				text = decoder.decode(bytes);
			} catch (error) {
				reading.unreadable.push({ path, message: messageOf(error) });
				continue;
			}
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			// Preparation refused body codecs, so every table here is a folder table.
			const { data: row, error: issues } = parseRow(
				table as PreparedFolderTable,
				text,
			);
			if (issues !== null) {
				for (const issue of issues)
					reading.invalid.push({ table: name, sha256, path, ...issue });
				continue;
			}
			projected.rows.push({
				id: file.slice(0, -'.md'.length),
				path,
				sha256,
				fields: row.fields as Record<string, unknown>,
				body: row.body,
			});
		}
	}
	return { data: reading, error: null };
}

/**
 * `path:line: message`, compiler style. The message already names its field,
 * so the field stays in `--json` and `_invalid` rather than the text.
 */
export function formatDiagnostic({ path, line, message }: Diagnostic) {
	return `${line === undefined ? path : `${path}:${line}`}: ${message}`;
}

function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function rowCount(reading: DataFolderReading) {
	return reading.tables.reduce((sum, table) => sum + table.rows.length, 0);
}

/** Paths with at least one finding, so a row with three issues counts once. */
function invalidPaths(reading: DataFolderReading) {
	return new Set(reading.invalid.map(({ path }) => path));
}

// ============================================================================
// check
// ============================================================================

export type CheckReport = {
	root: string;
	rows: number;
	invalid: Diagnostic[];
	unreadable: Diagnostic[];
	exitCode: 0 | 1 | 2;
};

export async function checkDataFolder(dir: string): Promise<CheckReport> {
	const { data: reading, error } = await readDataFolder(dir);
	if (error !== null)
		return {
			root: resolve(dir),
			rows: 0,
			invalid: [],
			unreadable: [error],
			exitCode: 2,
		};
	const invalid = reading.invalid.map(({ path, line, field, message }) => ({
		path,
		line,
		field,
		message,
	}));
	return {
		root: reading.root,
		rows: rowCount(reading),
		invalid,
		unreadable: reading.unreadable,
		exitCode: reading.unreadable.length ? 2 : invalid.length ? 1 : 0,
	};
}

export function formatCheckReport(report: CheckReport) {
	return [
		...report.unreadable.map(formatDiagnostic),
		...report.invalid.map(formatDiagnostic),
		`${count(report.rows, 'row')} conform; ${count(new Set(report.invalid.map(({ path }) => path)).size, 'file')} invalid; ${report.unreadable.length} unreadable.`,
	].join('\n');
}

// ============================================================================
// query
// ============================================================================

/** A SQL identifier, quoted, because declared field names may be keywords. */
function quote(name: string) {
	return `"${name.replaceAll('"', '""')}"`;
}

/** A field value as SQLite stores it: JSON text for lists and objects. */
function toSql(value: unknown) {
	if (value === undefined || value === null) return null;
	if (typeof value === 'boolean') return value ? 1 : 0;
	if (typeof value === 'object') return JSON.stringify(value);
	return value as string | number;
}

/**
 * Build the projection ADR-0520 describes, then make it read-only so a
 * statement that writes fails rather than appearing to change a row.
 */
export function projectDataFolder(reading: DataFolderReading) {
	const db = new Database(':memory:');
	db.transaction(() => {
		for (const table of reading.tables) {
			const columns = [
				'id',
				'_path',
				'_sha256',
				...table.fields.map(({ name }) => name),
				'_body',
			];
			db.run(
				`CREATE TABLE ${quote(table.name)} (${columns
					.map((column) =>
						column === 'id' ? 'id TEXT PRIMARY KEY' : quote(column),
					)
					.join(', ')})`,
			);
			const insert = db.prepare(
				`INSERT INTO ${quote(table.name)} VALUES (${columns.map(() => '?').join(', ')})`,
			);
			for (const row of table.rows)
				insert.run(
					row.id,
					row.path,
					row.sha256,
					...table.fields.map(({ name }) => toSql(row.fields[name])),
					row.body,
				);
		}
		db.run('CREATE TABLE _kv (key TEXT PRIMARY KEY, value TEXT)');
		const kv = db.prepare('INSERT INTO _kv VALUES (?, ?)');
		for (const { key, value } of reading.kv) kv.run(key, JSON.stringify(value));
		db.run(
			'CREATE TABLE _invalid (table_name TEXT, _path TEXT, _sha256 TEXT, line INTEGER, field TEXT, message TEXT)',
		);
		const invalid = db.prepare(
			'INSERT INTO _invalid VALUES (?, ?, ?, ?, ?, ?)',
		);
		for (const finding of [...reading.invalid, ...reading.unreadable]) {
			const { table, sha256 } = finding as InvalidRow;
			invalid.run(
				table ?? null,
				finding.path,
				sha256 ?? null,
				finding.line ?? null,
				finding.field ?? null,
				finding.message,
			);
		}
	})();
	db.run('PRAGMA query_only = ON');
	return db;
}

/**
 * What a field holds, read for a person writing SQL: its allowed values when
 * it has them, otherwise its JSON Schema type or format. Hand-written
 * declarations carry no editor hint, so the schema's own keywords come first.
 */
function valuesOf(schema: object): string {
	const node = schema as {
		enum?: unknown[];
		anyOf?: object[];
		type?: string | string[];
		format?: string;
		items?: object;
	};
	if (Array.isArray(node.enum)) return node.enum.map(String).join('|');
	if (Array.isArray(node.anyOf)) return node.anyOf.map(valuesOf).join('|');
	if (node.format) return node.format;
	if (node.type === 'array' && node.items)
		return `list of ${valuesOf(node.items)}`;
	if (node.type) return [node.type].flat().join('|');
	const editor = fieldEditorOf(schema as Parameters<typeof fieldEditorOf>[0]);
	return 'options' in editor && editor.options
		? editor.options.join('|')
		: editor.kind;
}

/** What an agent needs before writing SQL: tables, columns, allowed values, counts. */
export function describeDataFolder(reading: DataFolderReading) {
	const left = invalidPaths(reading);
	const lines: string[] = [];
	for (const table of reading.tables) {
		const invalid = [...left].filter((path) =>
			path.startsWith(`${table.name}/`),
		).length;
		lines.push(
			`${table.name}: ${count(table.rows.length, 'row')}${invalid ? `, ${invalid} invalid` : ''}`,
		);
		const fields = table.fields.map(
			({ name, schema }) => `${name} (${valuesOf(schema)})`,
		);
		lines.push(`  id, _path, _sha256, ${[...fields, '_body'].join(', ')}`);
	}
	lines.push(`_kv: ${count(reading.kv.length, 'value')}`);
	lines.push('_invalid: table_name, _path, _sha256, line, field, message');
	return lines.join('\n');
}

/** Rows as tab-separated text with a header, the shape shell tools read. */
function formatRows(columns: string[], rows: Record<string, unknown>[]) {
	const cell = (value: unknown) =>
		value === null || value === undefined
			? ''
			: String(value).replaceAll('\t', ' ').replaceAll('\n', '\\n');
	return [
		columns.join('\t'),
		...rows.map((row) => columns.map((column) => cell(row[column])).join('\t')),
	].join('\n');
}

/** How many rows each table left out, and where, after a statement's results. */
function formatLeftOut(reading: DataFolderReading) {
	const findings = [...reading.unreadable, ...reading.invalid];
	if (!findings.length) return '';
	return [
		`${invalidPaths(reading).size + reading.unreadable.length} files not in the projection:`,
		...findings.map(formatDiagnostic),
	].join('\n');
}

/**
 * Run `epicenter check` or `epicenter query` and return the exit code. Output
 * goes to stdout; for `query`, rows left out of the projection go to stderr so
 * piped results stay clean.
 */
export async function runDataFolderCommand(
	command: 'check' | 'query',
	args: string[],
	json: boolean,
): Promise<number> {
	const [dir, sql, ...extra] = args;
	if (!dir || extra.length || (command === 'check' && sql !== undefined)) {
		process.stderr.write(
			`Usage: epicenter check <dir> [--json]\n       epicenter query <dir> [<sql>] [--json]\n`,
		);
		return 2;
	}
	if (command === 'check') {
		const report = await checkDataFolder(dir);
		process.stdout.write(
			`${json ? JSON.stringify(report, null, 2) : formatCheckReport(report)}\n`,
		);
		return report.exitCode;
	}

	const { data: reading, error } = await readDataFolder(dir);
	if (error !== null) {
		if (json) process.stdout.write(`${JSON.stringify({ error }, null, 2)}\n`);
		else process.stderr.write(`${formatDiagnostic(error)}\n`);
		return 2;
	}
	const leftOut = [...reading.unreadable, ...reading.invalid];
	if (sql === undefined) {
		process.stdout.write(
			json
				? `${JSON.stringify(
						{
							tables: reading.tables.map(({ name, fields, rows }) => ({
								name,
								fields: fields.map((field) => field.name),
								rows: rows.length,
							})),
							kv: reading.kv.length,
							leftOut,
						},
						null,
						2,
					)}\n`
				: `${describeDataFolder(reading)}\n`,
		);
		if (!json && leftOut.length)
			process.stderr.write(`${formatLeftOut(reading)}\n`);
		return 0;
	}

	const db = projectDataFolder(reading);
	try {
		const statement = db.query(sql);
		const rows = statement.all() as Record<string, unknown>[];
		const columns = statement.columnNames;
		if (json)
			process.stdout.write(
				`${JSON.stringify({ columns, rows, leftOut }, null, 2)}\n`,
			);
		else {
			process.stdout.write(`${formatRows(columns, rows)}\n`);
			if (leftOut.length) process.stderr.write(`${formatLeftOut(reading)}\n`);
		}
		return 0;
	} catch (error) {
		const message = messageOf(error);
		if (json)
			process.stdout.write(
				`${JSON.stringify({ error: { message } }, null, 2)}\n`,
			);
		else process.stderr.write(`${message}\n`);
		return 2;
	} finally {
		db.close();
	}
}
