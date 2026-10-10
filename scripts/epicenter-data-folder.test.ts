/**
 * `epicenter check` and `epicenter query` against real directories, through
 * fresh CLI processes: exit codes, compiler-style diagnostics, the projection's
 * columns and values, read-only statements, and that nothing in the folder is
 * executed or changed.
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
	kv: { owner: { type: 'string' } },
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
			},
		},
		accounts: { fields: { platform: { type: 'string' } } },
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
	const folder = await mkdtemp(join(tmpdir(), 'epicenter-data-folder-test-'));
	temporaryFolders.push(folder);
	async function write(path: string, value: string | Uint8Array) {
		await mkdir(dirname(join(folder, path)), { recursive: true });
		await writeFile(join(folder, path), value);
	}
	await write('epicenter.json', JSON.stringify(declaration));
	await write('kv.json', '{"owner":"braden"}');
	await write(
		'posts/reel.md',
		'---\ntitle: Reel\nstatus: drafting\ndue: 2026-10-11\norder: 1\npinned: true\ntags: [a, b]\n---\nCut done.\n',
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
	expect(result.stdout).toBe('1 row conform; 0 files invalid; 0 unreadable.\n');
});

test('check reports invalid rows compiler style and exits 1', async () => {
	const { folder, write, run } = await setup();
	await write(
		'posts/launch.md',
		'---\ntitle: Launch\nstatus: someday\ndue: null\norder: 2\npinned: false\ntags: []\n---\n',
	);
	await write('posts/broken.md', 'no fences\n');
	const result = run('check', folder, '--json');
	expect(result.exitCode).toBe(1);
	const report = JSON.parse(result.stdout);
	expect(report.rows).toBe(1);
	expect(report.invalid).toEqual([
		expect.objectContaining({ path: 'posts/broken.md', line: 1 }),
		expect.objectContaining({
			path: 'posts/launch.md',
			line: 3,
			field: 'status',
		}),
	]);
	expect(run('check', folder).stdout).toContain('posts/launch.md:3: status');
});

test('check exits 2 for a directory without epicenter.json, a bad declaration, or unreadable text', async () => {
	const { folder, write, run } = await setup();
	const empty = await mkdtemp(join(tmpdir(), 'epicenter-data-folder-test-'));
	temporaryFolders.push(empty);
	const missing = run('check', empty);
	expect(missing.exitCode).toBe(2);
	expect(missing.stdout).toContain('has no epicenter.json');

	await write(
		'posts/latin1.md',
		new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff]),
	);
	expect(run('check', folder).exitCode).toBe(2);

	await write(
		'epicenter.json',
		'{"kv": {}, "tables": {"bad name": {"fields": {}}}}',
	);
	expect(run('check', folder).exitCode).toBe(2);
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

test('query without a statement describes tables, columns, and allowed values', async () => {
	const { folder, run } = await setup();
	const result = run('query', folder);
	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(
		[
			'posts: 1 row',
			'  id, _path, _sha256, title (string), status (planned|drafting|done), due (date|null), order (number), pinned (boolean), tags (list of string), _body',
			'accounts: 0 rows',
			'  id, _path, _sha256, platform (string), _body',
			'_kv: 1 value',
			'_invalid: table_name, _path, _sha256, line, field, message',
			'',
		].join('\n'),
	);
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

test('query leaves invalid rows out, lists them in _invalid, and reports them on stderr', async () => {
	const { folder, write, run } = await setup();
	await write('posts/broken.md', 'no fences\n');
	const counted = run('query', folder, 'SELECT count(*) AS n FROM posts');
	expect(counted.stdout).toBe('n\n1\n');
	expect(counted.stderr).toContain('posts/broken.md:1:');
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

test('query exposes kv.json as _kv JSON values', async () => {
	const { folder, run } = await setup();
	const result = run('query', folder, 'SELECT key, value FROM _kv', '--json');
	expect(JSON.parse(result.stdout).rows).toEqual([
		{ key: 'owner', value: '"braden"' },
	]);
});

test('query refuses a statement that writes and leaves every file unchanged', async () => {
	const { folder, run } = await setup();
	const before = await readFile(join(folder, 'posts/reel.md'), 'utf8');
	const result = run('query', folder, `UPDATE posts SET status = 'done'`);
	expect(result.exitCode).toBe(2);
	expect(result.stderr).toContain('readonly');
	expect(await readFile(join(folder, 'posts/reel.md'), 'utf8')).toBe(before);
});

test('check and query reject missing or extra arguments', async () => {
	const { folder, run } = await setup();
	expect(run('check').exitCode).toBe(2);
	expect(run('check', folder, 'SELECT 1').exitCode).toBe(2);
	expect(run('query', folder, 'SELECT 1', 'extra').exitCode).toBe(2);
});
