/**
 * `epicenter check` and `epicenter query` against real directories, through
 * fresh CLI processes: exit codes, compiler-style diagnostics, the projection's
 * columns and values, the one-statement read-only rule, and that nothing in the
 * folder is executed or changed.
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const cli = resolve(import.meta.dir, 'epicenter.ts');
const temporaryFolders: string[] = [];

const declaration = {
	kv: {},
	tables: {
		posts: {
			fields: {
				title: { type: 'string' },
				status: {
					enum: ['planned', 'drafting', 'done'],
					'x-field': { kind: 'select' },
				},
				due: { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
				order: { type: 'number' },
				pinned: { type: 'boolean' },
				tags: { type: 'array', items: { type: 'string' } },
				account: {
					type: 'string',
					minLength: 1,
					'x-field': { kind: 'reference', target: 'accounts' },
				},
			},
		},
		accounts: { fields: { kind: { const: 'social' } } },
	},
};

afterEach(async () => {
	await Promise.all(
		temporaryFolders
			.splice(0)
			.map((folder) => rm(folder, { recursive: true, force: true })),
	);
});

async function setup() {
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(folder);
	async function write(path: string, value: string | Uint8Array) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		await writeFile(join(folder, path), value);
	}
	await write('epicenter.json', JSON.stringify(declaration));
	await write(
		'posts/reel.md',
		'---\ntitle: Reel\nstatus: drafting\ndue: 2026-10-11\norder: 1\npinned: true\ntags: [a, b]\naccount: instagram\n---\nCut done.\n',
	);
	function run(...args: string[]) {
		const result = Bun.spawnSync(
			[process.execPath, '--no-install', cli, ...args],
			{ cwd: folder, stdout: 'pipe', stderr: 'pipe' },
		);
		return {
			exitCode: result.exitCode,
			stdout: result.stdout.toString(),
			stderr: result.stderr.toString(),
		};
	}
	return { folder, write, run };
}

// ============================================================================
// check
// ============================================================================

test('check passes a conforming data folder', async () => {
	const { folder, run } = await setup();
	const result = run('check', folder);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(
		'1 row conforms; 0 files invalid; 0 unreadable.\n',
	);
});

test('check reports invalid rows compiler style and exits 1', async () => {
	const { folder, write, run } = await setup();
	await write(
		'posts/launch.md',
		'---\ntitle: Launch\nstatus: someday\ndue: null\norder: 2\npinned: false\ntags: []\naccount: instagram\n---\n',
	);
	await write('posts/broken.md', 'no fences\n');
	await write(
		'posts/latin1.md',
		new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]),
	);
	const result = run('check', folder, '--json');
	expect(result.exitCode).toBe(1);
	const report = JSON.parse(result.stdout);
	expect(report.rows).toBe(1);
	expect(report.invalid).toEqual([
		expect.objectContaining({
			table: 'posts',
			path: 'posts/broken.md',
			line: 1,
		}),
		expect.objectContaining({
			table: 'posts',
			path: 'posts/latin1.md',
			message: 'The file is not valid UTF-8',
		}),
		expect.objectContaining({
			table: 'posts',
			path: 'posts/launch.md',
			line: 3,
			field: 'status',
		}),
	]);
	expect(report.invalid[0].sha256).toMatch(/^[0-9a-f]{64}$/);
	expect(run('check', folder).stdout).toContain(
		'posts/launch.md:3: status does not conform',
	);
});

test('a missing or unusable epicenter.json is a tool failure with exit 2', async () => {
	const { folder, write, run } = await setup();
	const empty = await mkdtemp(join(tmpdir(), 'epicenter-cli-test-'));
	temporaryFolders.push(empty);
	const missing = run('check', empty);
	expect(missing.exitCode).toBe(2);
	expect(missing.stderr).toContain('has no epicenter.json');
	expect(JSON.parse(run('check', empty, '--json').stdout).error).toContain(
		'has no epicenter.json',
	);

	await write(
		'epicenter.json',
		'{"kv": {}, "tables": {"bad name": {"fields": {}}}}',
	);
	expect(run('check', folder).exitCode).toBe(2);
});

test('fields that differ only by case are refused before any query', async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.json',
		JSON.stringify({
			kv: {},
			tables: {
				posts: {
					fields: { title: { type: 'string' }, Title: { type: 'string' } },
				},
			},
		}),
	);
	const result = run('query', folder, 'SELECT 1');
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain("'title' and 'Title'");
});

test('a folder never runs its own code', async () => {
	const { folder, write, run } = await setup();
	await write(
		'epicenter.config.ts',
		`import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(folder, 'ran'))}, 'yes');\nexport default {};`,
	);
	expect(run('check', folder).exitCode).toBe(0);
	expect(run('query', folder, 'SELECT 1').exitCode).toBe(0);
	expect(await readdir(folder)).not.toContain('ran');
});

// ============================================================================
// query
// ============================================================================

test('query without a statement describes columns, allowed values, and references', async () => {
	const { folder, run } = await setup();
	const result = run('query', folder);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(
		[
			'posts: 1 row',
			'  id: the file stem',
			'  _path: path from the data folder',
			'  _sha256: hash of the file bytes',
			'  title: string',
			'  status: planned|drafting|done',
			'  due: date|null',
			'  order: number',
			'  pinned: boolean',
			'  tags: list of string',
			'  account: stem in accounts',
			'  _body: Markdown after the frontmatter',
			'accounts: 0 rows',
			'  id: the file stem',
			'  _path: path from the data folder',
			'  _sha256: hash of the file bytes',
			'  kind: social',
			'  _body: Markdown after the frontmatter',
			'_invalid: table_name, _path, _sha256, line, field, message',
			'',
		].join('\n'),
	);
	const described = JSON.parse(run('query', folder, '--json').stdout);
	expect(described.tables[0].columns).toContainEqual({
		name: 'status',
		values: 'planned|drafting|done',
	});
});

test('query projects rows with quoted keyword columns and SQLite values', async () => {
	const { folder, run } = await setup();
	const result = run(
		'query',
		folder,
		`SELECT id, _path, "order", pinned, tags, due, _body FROM posts WHERE status != 'done'`,
		'--json',
	);
	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		columns: ['id', '_path', 'order', 'pinned', 'tags', 'due', '_body'],
		rows: [
			{
				id: 'reel',
				_path: 'posts/reel.md',
				order: 1,
				pinned: 1,
				tags: '["a","b"]',
				due: '2026-10-11',
				_body: 'Cut done.\n',
			},
		],
		leftOut: [],
	});
});

test('query prints one line per row, escaping tabs, newlines, and backslashes', async () => {
	const { folder, run } = await setup();
	const result = run(
		'query',
		folder,
		`SELECT _body, 'a\tb\\c' AS x FROM posts`,
	);
	expect(result.stdout).toBe('_body\tx\nCut done.\\n\ta\\tb\\\\c\n');
});

test('query leaves invalid rows out, lists them in _invalid, and reports them per table', async () => {
	const { folder, write, run } = await setup();
	await write('posts/broken.md', 'no fences\n');
	const counted = run('query', folder, 'SELECT count(*) AS n FROM posts');
	expect(counted.stdout).toBe('n\n1\n');
	expect(counted.stderr).toBe(
		'posts: 1 file left out\nposts/broken.md:1: The source does not start with a --- line\n',
	);
	const listed = run(
		'query',
		folder,
		'SELECT table_name, _path, line FROM _invalid',
		'--json',
	);
	expect(JSON.parse(listed.stdout).rows).toEqual([
		{ table_name: 'posts', _path: 'posts/broken.md', line: 1 },
	]);
});

test('query refuses statements that write, attach, or vacuum, and leaves the directory unchanged', async () => {
	const { folder, run } = await setup();
	const before = await readdir(folder, { recursive: true });
	for (const sql of [
		`UPDATE posts SET status = 'done'`,
		`ATTACH 'copy.db' AS copy`,
		`VACUUM INTO 'copy.db'`,
		'PRAGMA query_only = OFF',
	]) {
		const result = run('query', folder, sql);
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toContain('query only reads');
	}
	expect(await readdir(folder, { recursive: true })).toEqual(before);
	expect(await readFile(join(folder, 'posts/reel.md'), 'utf8')).toContain(
		'status: drafting',
	);
});

test('query runs exactly one statement and accepts leading and trailing comments', async () => {
	const { folder, run } = await setup();
	const two = run('query', folder, 'SELECT 1; SELECT 2');
	expect(two.exitCode).toBe(2);
	expect(two.stderr).toContain('one statement');
	expect(
		run('query', folder, '-- due today\nSELECT 1 AS n; -- done').stdout,
	).toBe('n\n1\n');
	expect(run('query', folder, '   ').exitCode).toBe(2);
});

test('the CLI rejects missing or extra arguments', async () => {
	const { folder, run } = await setup();
	expect(run('check').exitCode).toBe(2);
	expect(run('check', folder, 'SELECT 1').exitCode).toBe(2);
	expect(run('query', folder, 'SELECT 1', 'extra').exitCode).toBe(2);
	expect(run('validate', folder).exitCode).toBe(2);
	expect(run('--help').stdout).toContain('epicenter check <dir>');
});
