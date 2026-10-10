#!/usr/bin/env -S bun --no-install
/**
 * The Epicenter CLI: `check` and `query` a data folder by its path (ADR-0520).
 *
 * Both read `<dir>/epicenter.json` and parse every declared row with the
 * folder package's `parseRow`. `check` reports rows that do not conform;
 * `query` answers one read-only SQL statement over an in-memory projection
 * (ADR-0494). Nothing here writes a file, executes the folder's code, reads
 * Git, or contacts a network.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
	type FolderDefinition,
	type PreparedFolderTable,
	prepareFolderDefinition,
} from '../packages/folder/src/definition.js';
import { parseRow } from '../packages/folder/src/row-text.js';

const usage = `Usage:
  epicenter check <dir> [--json]
  epicenter query <dir> [<sql>] [--json]

check prints one line per row that does not conform and exits 0 when every row
conforms, 1 when a row does not, and 2 when the folder cannot be read.
query without a statement describes the folder's tables; with one, it runs that
single read-only statement and prints tab-separated rows.`;

const DECLARATION = 'epicenter.json';

/** One finding, located as precisely as the source allows. */
type Diagnostic = {
	table?: string;
	path: string;
	sha256?: string;
	line?: number;
	field?: string;
	message: string;
};

type Row = {
	id: string;
	path: string;
	sha256: string;
	fields: Record<string, unknown>;
	body: string;
};

type Table = {
	name: string;
	fields: { name: string; schema: object }[];
	rows: Row[];
	/** Row files left out of the projection, with every finding for each. */
	invalid: Diagnostic[];
};

/**
 * A data folder read whole. `unreadable` holds what could not be read at all,
 * such as a table directory that is not a directory; each table holds the rows
 * that conform and the findings for those that do not.
 */
type Reading = { root: string; tables: Table[]; unreadable: Diagnostic[] };

const decoder = new TextDecoder('utf-8', { fatal: true });

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown) {
	return (error as { code?: unknown } | null)?.code;
}

function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Read `<dir>/epicenter.json` and every row it declares. A declaration that
 * cannot be read or prepared throws; every later problem is recorded, so one
 * bad row never hides the rest.
 */
async function readDataFolder(dir: string): Promise<Reading> {
	const root = resolve(dir);
	let declared: unknown;
	try {
		declared = JSON.parse(
			decoder.decode(await readFile(join(root, DECLARATION))),
		);
	} catch (error) {
		throw new Error(
			codeOf(error) === 'ENOENT'
				? `${root} is not a data folder: it has no ${DECLARATION}`
				: `${join(root, DECLARATION)}: ${messageOf(error)}`,
		);
	}
	const { data: definition, error: definitionError } = prepareFolderDefinition(
		declared as FolderDefinition,
	);
	if (definitionError !== null)
		throw new Error(`${join(root, DECLARATION)}: ${definitionError.reason}`);

	const reading: Reading = { root, tables: [], unreadable: [] };
	for (const [name, table] of Object.entries(definition.tables)) {
		const fields = Object.entries(table.fields).map(([field, schema]) => ({
			name: field,
			schema,
		}));
		const seen = new Map<string, string>();
		for (const { name: field } of fields) {
			const folded = field.toLowerCase();
			const other = seen.get(folded);
			// SQLite compares column names without case, so these cannot both be columns.
			if (other !== undefined)
				throw new Error(
					`${join(root, DECLARATION)}: table '${name}' declares '${other}' and '${field}', which differ only by case`,
				);
			seen.set(folded, field);
		}
		const projected: Table = { name, fields, rows: [], invalid: [] };
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
				reading.unreadable.push({
					table: name,
					path: name,
					message: messageOf(error),
				});
			continue;
		}
		for (const file of files) {
			const path = `${name}/${file}`;
			let bytes: Uint8Array;
			try {
				bytes = await readFile(join(root, path));
			} catch (error) {
				reading.unreadable.push({
					table: name,
					path,
					message: messageOf(error),
				});
				continue;
			}
			const sha256 = createHash('sha256').update(bytes).digest('hex');
			let text: string;
			try {
				text = decoder.decode(bytes);
			} catch {
				// Bytes that are not UTF-8 are a defect in the file, not in the tool.
				projected.invalid.push({
					table: name,
					path,
					sha256,
					message: 'The file is not valid UTF-8',
				});
				continue;
			}
			// Preparation refused body codecs, so every table here is a folder table.
			const { data: row, error: issues } = parseRow(
				table as PreparedFolderTable,
				text,
			);
			if (issues !== null) {
				for (const issue of issues)
					projected.invalid.push({ table: name, path, sha256, ...issue });
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
	return reading;
}

/**
 * `path:line: message`, compiler style. The message already names its field,
 * so the field stays in `--json` and `_invalid` rather than the text.
 */
function formatDiagnostic({ path, line, message }: Diagnostic) {
	return `${line === undefined ? path : `${path}:${line}`}: ${message}`;
}

function invalidFindings(reading: Reading) {
	return reading.tables.flatMap((table) => table.invalid);
}

/** Files with at least one finding, so a row with three issues counts once. */
function invalidFileCount(table: Table) {
	return new Set(table.invalid.map(({ path }) => path)).size;
}

// ============================================================================
// check
// ============================================================================

async function check(dir: string, json: boolean) {
	const reading = await readDataFolder(dir);
	const invalid = invalidFindings(reading);
	const rows = reading.tables.reduce(
		(sum, table) => sum + table.rows.length,
		0,
	);
	const exitCode = reading.unreadable.length ? 2 : invalid.length ? 1 : 0;
	const files = reading.tables.reduce(
		(sum, table) => sum + invalidFileCount(table),
		0,
	);
	process.stdout.write(
		json
			? `${JSON.stringify(
					{
						root: reading.root,
						rows,
						invalid,
						unreadable: reading.unreadable,
						exitCode,
					},
					null,
					2,
				)}\n`
			: `${[
					...reading.unreadable.map(formatDiagnostic),
					...invalid.map(formatDiagnostic),
					`${count(rows, 'row')} ${rows === 1 ? 'conforms' : 'conform'}; ${count(files, 'file')} invalid; ${reading.unreadable.length} unreadable.`,
				].join('\n')}\n`,
	);
	return exitCode;
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
 * Build the projection ADR-0520 describes, then make it read-only, so a
 * statement that changes rows fails rather than appearing to succeed.
 */
function project(reading: Reading) {
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
		db.run(
			'CREATE TABLE _invalid (table_name TEXT, _path TEXT, _sha256 TEXT, line INTEGER, field TEXT, message TEXT)',
		);
		const invalid = db.prepare(
			'INSERT INTO _invalid VALUES (?, ?, ?, ?, ?, ?)',
		);
		for (const finding of [...invalidFindings(reading), ...reading.unreadable])
			invalid.run(
				finding.table ?? null,
				finding.path,
				finding.sha256 ?? null,
				finding.line ?? null,
				finding.field ?? null,
				finding.message,
			);
	})();
	db.run('PRAGMA query_only = ON');
	return db;
}

const LEADING_TRIVIA = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const TRAILING_TRIVIA = /--[^\n]*|\/\*[\s\S]*?\*\/|[\s;]/g;

/**
 * Prepare exactly one statement that only reads. `query_only` stops changes
 * to the projection, but not `ATTACH` or `VACUUM INTO`, which create files,
 * so the statement must start with a reading keyword. SQLite prepares only
 * the first of several statements, so anything after it is refused rather
 * than silently ignored.
 */
function prepareRead(db: Database, sql: string) {
	const keyword = sql
		.replace(LEADING_TRIVIA, '')
		.match(/^[A-Za-z]+/)?.[0]
		?.toUpperCase();
	if (!keyword)
		throw new Error('query takes one SQL statement; this one is empty');
	if (!['SELECT', 'WITH', 'VALUES', 'EXPLAIN'].includes(keyword))
		throw new Error(
			`query only reads: a statement must start with SELECT, WITH, VALUES, or EXPLAIN, not ${keyword}`,
		);
	const statement = db.query(sql);
	if (sql.slice(statement.toString().length).replace(TRAILING_TRIVIA, ''))
		throw new Error(
			'query runs one statement; remove everything after the first',
		);
	return statement;
}

/**
 * What a field holds, read for a person writing SQL: its allowed values when
 * it has them, otherwise its JSON Schema type, format, or reference target.
 */
function valuesOf(schema: object): string {
	const node = schema as {
		const?: unknown;
		enum?: unknown[];
		anyOf?: object[];
		type?: string | string[];
		format?: string;
		items?: object;
		'x-field'?: { kind?: string; target?: string };
	};
	const literal = (value: unknown) =>
		typeof value === 'string' ? value : JSON.stringify(value);
	if ('const' in node) return literal(node.const);
	if (Array.isArray(node.enum)) return node.enum.map(literal).join('|');
	if (Array.isArray(node.anyOf)) return node.anyOf.map(valuesOf).join('|');
	if (node['x-field']?.kind === 'reference' && node['x-field'].target)
		return `stem in ${node['x-field'].target}`;
	if (node.format) return node.format;
	if (node.type === 'array' && node.items)
		return `list of ${valuesOf(node.items)}`;
	if (node.type) return [node.type].flat().join('|');
	return 'any JSON';
}

function describe(reading: Reading) {
	return reading.tables.map((table) => ({
		name: table.name,
		rows: table.rows.length,
		invalid: invalidFileCount(table),
		columns: [
			{ name: 'id', values: 'the file stem' },
			{ name: '_path', values: 'path from the data folder' },
			{ name: '_sha256', values: 'hash of the file bytes' },
			...table.fields.map(({ name, schema }) => ({
				name,
				values: valuesOf(schema),
			})),
			{ name: '_body', values: 'Markdown after the frontmatter' },
		],
	}));
}

function formatDescription(reading: Reading) {
	return [
		...describe(reading).flatMap((table) => [
			`${table.name}: ${count(table.rows, 'row')}${table.invalid ? `, ${table.invalid} invalid` : ''}`,
			...table.columns.map(({ name, values }) => `  ${name}: ${values}`),
		]),
		'_invalid: table_name, _path, _sha256, line, field, message',
	].join('\n');
}

/**
 * Rows as tab-separated text with a header. Backslash, tab, newline, and
 * carriage return are escaped, so every row is one line and splits exactly.
 */
function formatRows(columns: string[], rows: Record<string, unknown>[]) {
	const cell = (value: unknown) =>
		value === null || value === undefined
			? ''
			: String(value)
					.replaceAll('\\', '\\\\')
					.replaceAll('\t', '\\t')
					.replaceAll('\n', '\\n')
					.replaceAll('\r', '\\r');
	return [
		columns.join('\t'),
		...rows.map((row) => columns.map((column) => cell(row[column])).join('\t')),
	].join('\n');
}

/** Per table, how many files the projection left out, and every finding. */
function formatLeftOut(reading: Reading) {
	const lines = [
		...reading.unreadable.map(formatDiagnostic),
		...reading.tables.flatMap((table) =>
			table.invalid.length
				? [
						`${table.name}: ${count(invalidFileCount(table), 'file')} left out`,
						...table.invalid.map(formatDiagnostic),
					]
				: [],
		),
	];
	return lines.length ? `${lines.join('\n')}\n` : '';
}

async function query(dir: string, sql: string | undefined, json: boolean) {
	const reading = await readDataFolder(dir);
	const leftOut = [...reading.unreadable, ...invalidFindings(reading)];
	if (sql === undefined) {
		process.stdout.write(
			json
				? `${JSON.stringify({ tables: describe(reading), leftOut }, null, 2)}\n`
				: `${formatDescription(reading)}\n`,
		);
		if (!json) process.stderr.write(formatLeftOut(reading));
		return 0;
	}
	const db = project(reading);
	try {
		const statement = prepareRead(db, sql);
		const rows = statement.all() as Record<string, unknown>[];
		const columns = statement.columnNames;
		if (json)
			process.stdout.write(
				`${JSON.stringify({ columns, rows, leftOut }, null, 2)}\n`,
			);
		else {
			process.stdout.write(`${formatRows(columns, rows)}\n`);
			process.stderr.write(formatLeftOut(reading));
		}
		return 0;
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	// Options are matched exactly, so a statement that starts with `--` stays a statement.
	const args = Bun.argv.slice(2);
	const json = args.includes('--json');
	const [command, dir, sql, ...extra] = args.filter((arg) => arg !== '--json');
	try {
		if (command === '--help' || command === '-h' || command === undefined)
			process.stdout.write(`${usage}\n`);
		else if (command === 'check' && dir && sql === undefined)
			process.exitCode = await check(dir, json);
		else if (command === 'query' && dir && !extra.length)
			process.exitCode = await query(dir, sql, json);
		else throw new Error(usage);
	} catch (error) {
		// A thrown error is the tool failing: a bad declaration, statement, or command.
		const message = messageOf(error);
		if (json)
			process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
		else process.stderr.write(`${message}\n`);
		process.exitCode = 2;
	}
}
