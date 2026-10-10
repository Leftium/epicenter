#!/usr/bin/env -S bun --no-install
/**
 * The Epicenter CLI: `check` and `query` a data folder by its path (ADR-0520).
 *
 * Both read `<dir>/epicenter.json` and parse every declared row with the
 * folder package's `parseRow`. `check` reports rows that do not conform.
 * `query` answers one read-only SQL statement over an in-memory projection
 * (ADR-0494), and only for a folder whose rows all conform: a broken row is
 * fixed in its Markdown first. Nothing here writes a file, executes the
 * folder's code, reads Git, or contacts a network.
 */
import { Database } from 'bun:sqlite';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
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

check prints one line per row that does not conform. query without a statement
describes the folder's tables; with one, it runs that single read-only
statement and prints tab-separated rows. query answers only when every row
conforms; otherwise fix the Markdown that check names.

Both exit 0 on success, 1 when a row does not conform, and 2 when the folder,
the declaration, or the statement cannot be used.`;

const DECLARATION = 'epicenter.json';

/** One finding, located as precisely as the source allows. */
type Finding = { path: string; line?: number; field?: string; message: string };

type Row = { stem: string; fields: Record<string, unknown>; body: string };

type Table = {
	name: string;
	schema: PreparedFolderTable;
	fields: { name: string; schema: object }[];
	rows: Row[];
};

const decoder = new TextDecoder('utf-8', { fatal: true });

function messageOf(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown) {
	return (error as { code?: unknown } | null)?.code;
}

/** An error ends the command: JSON on stdout with `--json`, otherwise stderr. */
function printError(message: string, json: boolean) {
	if (json)
		process.stdout.write(`${JSON.stringify({ error: message }, null, 2)}\n`);
	else process.stderr.write(`${message}\n`);
}

function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** Read and prepare `<dir>/epicenter.json`; a declaration that cannot be used throws. */
async function readDeclaration(dir: string): Promise<Table[]> {
	const path = join(resolve(dir), DECLARATION);
	let declared: unknown;
	try {
		declared = JSON.parse(decoder.decode(await readFile(path)));
	} catch (error) {
		throw new Error(
			codeOf(error) === 'ENOENT'
				? `${resolve(dir)} is not a data folder: it has no ${DECLARATION}`
				: `${path}: ${messageOf(error)}`,
		);
	}
	const { data: definition, error } = prepareFolderDefinition(
		declared as FolderDefinition,
	);
	if (error !== null) throw new Error(`${path}: ${error.reason}`);
	return Object.entries(definition.tables).map(([name, table]) => ({
		name,
		// JSON carries no body codec, so every declared table is a folder table.
		schema: table as PreparedFolderTable,
		fields: Object.entries(table.fields).map(([field, schema]) => ({
			name: field,
			schema,
		})),
		rows: [],
	}));
}

/**
 * Read every row file of every table into `table.rows`. A row file that does
 * not conform is `invalid`, something to fix in the folder; what cannot be
 * read at all is `unreadable`. Nothing is skipped silently, and nothing
 * outside the data folder is read.
 */
async function readRows(dir: string, tables: Table[]) {
	const root = resolve(dir);
	const invalid: Finding[] = [];
	const unreadable: Finding[] = [];
	for (const table of tables) {
		const directory = join(root, table.name);
		let entries: Dirent[];
		try {
			// A symbolic link would read rows from outside the data folder.
			if ((await lstat(directory)).isSymbolicLink()) {
				unreadable.push({
					path: table.name,
					message: 'The table directory is a symbolic link',
				});
				continue;
			}
			entries = await readdir(directory, { withFileTypes: true });
		} catch (error) {
			// A declared table with no directory has no rows yet.
			if (codeOf(error) !== 'ENOENT')
				unreadable.push({ path: table.name, message: messageOf(error) });
			continue;
		}
		const files = entries
			.filter((entry) => entry.name.endsWith('.md'))
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of files) {
			const path = `${table.name}/${entry.name}`;
			if (!entry.isFile()) {
				invalid.push({
					path,
					message:
						'A row must be a regular file, not a symbolic link or directory',
				});
				continue;
			}
			let bytes: Uint8Array;
			try {
				bytes = await readFile(join(root, path));
			} catch (error) {
				unreadable.push({ path, message: messageOf(error) });
				continue;
			}
			let text: string;
			try {
				text = decoder.decode(bytes);
			} catch {
				invalid.push({ path, message: 'The file is not valid UTF-8' });
				continue;
			}
			const { data: row, error: issues } = parseRow(table.schema, text);
			if (issues !== null) {
				for (const issue of issues) invalid.push({ path, ...issue });
				continue;
			}
			table.rows.push({
				stem: entry.name.slice(0, -'.md'.length),
				fields: row.fields as Record<string, unknown>,
				body: row.body,
			});
		}
	}
	return { invalid, unreadable };
}

/**
 * `path:line: message`, compiler style. The message already names its field,
 * so the field stays in `--json` rather than the text.
 */
function formatFinding({ path, line, message }: Finding) {
	return `${line === undefined ? path : `${path}:${line}`}: ${message}`;
}

/** Files with at least one finding, so a row with three issues counts once. */
function fileCount(findings: Finding[]) {
	return new Set(findings.map(({ path }) => path)).size;
}

// ============================================================================
// check
// ============================================================================

async function check(dir: string, json: boolean) {
	const tables = await readDeclaration(dir);
	const { invalid, unreadable } = await readRows(dir, tables);
	const rows = tables.reduce((sum, table) => sum + table.rows.length, 0);
	const exitCode = unreadable.length ? 2 : invalid.length ? 1 : 0;
	process.stdout.write(
		json
			? `${JSON.stringify({ rows, invalid, unreadable, exitCode }, null, 2)}\n`
			: `${[
					...unreadable.map(formatFinding),
					...invalid.map(formatFinding),
					`${count(rows, 'row')} ${rows === 1 ? 'conforms' : 'conform'}; ${count(fileCount(invalid), 'file')} invalid; ${unreadable.length} unreadable.`,
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

/** Columns the projection adds beside the declared fields. */
const ROW_COLUMNS = ['stem', 'body'];

/**
 * Refuse a declaration that cannot be one SQLite table per declared table:
 * SQLite compares column names without case, and `stem` and `body` are the
 * projection's own columns.
 */
function assertProjectable(table: Table) {
	const seen = new Map(ROW_COLUMNS.map((column) => [column, column]));
	for (const { name } of table.fields) {
		const other = seen.get(name.toLowerCase());
		if (other !== undefined)
			throw new Error(
				ROW_COLUMNS.includes(other)
					? `table '${table.name}' declares a field '${name}', but query uses '${other}' for the row itself`
					: `table '${table.name}' declares '${other}' and '${name}', which differ only by case`,
			);
		seen.set(name.toLowerCase(), name);
	}
}

/**
 * Build the projection ADR-0520 describes, one table per declared table,
 * then make it read-only, so a statement that changes rows fails rather than
 * appearing to succeed.
 */
function project(tables: Table[]) {
	const db = new Database(':memory:');
	db.transaction(() => {
		for (const table of tables) {
			const fields = table.fields.map(({ name }) => quote(name));
			db.run(
				`CREATE TABLE ${quote(table.name)} (stem TEXT PRIMARY KEY, ${[...fields, 'body'].join(', ')})`,
			);
			const insert = db.prepare(
				`INSERT INTO ${quote(table.name)} VALUES (${['?', ...fields.map(() => '?'), '?'].join(', ')})`,
			);
			for (const row of table.rows)
				insert.run(
					row.stem,
					...table.fields.map(({ name }) => toSql(row.fields[name])),
					row.body,
				);
		}
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

/** The declaration as SQL sees it: tables, columns, and what each column holds. */
function describe(tables: Table[]) {
	return tables.map((table) => ({
		name: table.name,
		columns: [
			{ name: 'stem', values: `the row's file is ${table.name}/<stem>.md` },
			...table.fields.map(({ name, schema }) => ({
				name,
				values: valuesOf(schema),
			})),
			{ name: 'body', values: 'Markdown after the frontmatter' },
		],
	}));
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

async function query(dir: string, sql: string | undefined, json: boolean) {
	const tables = await readDeclaration(dir);
	if (sql === undefined) {
		const description = describe(tables);
		process.stdout.write(
			json
				? `${JSON.stringify({ tables: description }, null, 2)}\n`
				: `${description
						.flatMap((table) => [
							`${table.name}:`,
							...table.columns.map(
								({ name, values }) => `  ${name}: ${values}`,
							),
						])
						.join('\n')}\n`,
		);
		return 0;
	}
	for (const table of tables) assertProjectable(table);
	const { invalid, unreadable } = await readRows(dir, tables);
	const broken = fileCount([...invalid, ...unreadable]);
	if (broken) {
		printError(
			`${count(broken, 'file')} ${broken === 1 ? 'does' : 'do'} not conform, so query will not answer; fix the Markdown that \`epicenter check ${dir}\` names`,
			json,
		);
		return unreadable.length ? 2 : 1;
	}
	const db = project(tables);
	try {
		const statement = prepareRead(db, sql);
		const rows = statement.all() as Record<string, unknown>[];
		const columns = statement.columnNames;
		process.stdout.write(
			json
				? `${JSON.stringify({ columns, rows }, null, 2)}\n`
				: `${formatRows(columns, rows)}\n`,
		);
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
		printError(messageOf(error), json);
		process.exitCode = 2;
	}
}
