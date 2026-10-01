/**
 * Capture Folder Bridge Tests
 *
 * A real directory, the real bridge handler, and a page that reaches it
 * through the real client transport. No socket is bound: the page's `fetch`
 * is the handler itself.
 *
 * Key behaviors:
 * - A page creates, lists, and saves captures as real files, with the
 *   folder's own Results crossing the bridge intact
 * - A stale save is a `Conflict` and leaves the file as the other writer left it
 * - Every complete save, table or raw, is followed by the folder's own commit
 * - A directory whose `.git` is a link or a pointer is refused before any
 *   Git command runs, and nothing is created in it
 * - Only the listed calls run, raw paths stay inside captures and recovery,
 *   and an unconditional overwrite is refused
 * - An outside edit reaches the page as a hint to reread
 * - A second owner of the same directory is refused
 * - A call that cannot reach the host is an `Io` Result, never a throw
 */
import { afterEach, expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createBridgeTransport,
	openBridgeFolder,
} from '../src/lib/bridge/client.js';
import { encode } from '../src/lib/bridge/codec.js';
import { BRIDGE_PATH, type BridgeReply } from '../src/lib/bridge/contract.js';
import { type CaptureBridge, createCaptureBridge } from './index.js';

const ORIGIN = 'http://capture.test';
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const run of cleanups.splice(0).reverse()) await run().catch(() => {});
});

async function git(cwd: string, ...args: string[]) {
	const child = Bun.spawn(['git', ...args], {
		cwd,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout] = await Promise.all([
		new Response(child.stdout).text(),
		child.exited,
	]);
	return stdout.trim();
}

async function eventually<T>(
	read: () => Promise<T> | T,
	accept: (value: T) => boolean,
) {
	const deadline = Date.now() + 5000;
	for (;;) {
		const value = await read();
		if (accept(value)) return value;
		if (Date.now() > deadline)
			throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
		await Bun.sleep(10);
	}
}

async function setup() {
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), 'capture-bridge-')),
	);
	cleanups.push(() => rm(parent, { recursive: true, force: true }));
	const root = join(parent, 'so.epicenter.capture');
	const bridge = createCaptureBridge({
		root,
		watchIntervalMs: 40,
		pingIntervalMs: 40,
	});
	cleanups.push(() => bridge.close());
	return { parent, root, bridge };
}

async function page(bridge: CaptureBridge) {
	const transport = createBridgeTransport({
		origin: ORIGIN,
		fetch: (request) => bridge.fetch(request),
		retryMs: 20,
	});
	const opened = await openBridgeFolder(transport);
	cleanups.push(() => opened.close());
	return opened;
}

async function raw(bridge: CaptureBridge, body: unknown) {
	const response = await bridge.fetch(
		new Request(`${ORIGIN}${BRIDGE_PATH}/call`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(encode(body)),
		}),
	);
	return {
		status: response.status,
		reply: (await response.json()) as BridgeReply,
	};
}

test('a page creates and saves captures as real files, and saves are committed', async () => {
	const { root, bridge } = await setup();
	const { folder, root: reported } = await page(bridge);
	expect(reported).toBe(root);

	const created = await folder.tables.captures.create({
		stem: 'one',
		fields: { capturedAt: '2026-10-01T10:30:00+08:00' as never },
		body: '\nText\n\n## Thoughts\n',
	});
	expect(created.error).toBeNull();
	const source =
		'---\ncapturedAt: 2026-10-01T10:30:00+08:00\n---\n\nText\n\n## Thoughts\n';
	expect(await readFile(join(root, 'captures/one.md'), 'utf8')).toBe(source);

	const listed = await folder.tables.captures.list();
	expect(listed.data?.entries.map((entry) => entry.path)).toEqual([
		'captures/one.md',
	]);
	expect(listed.data?.entries[0]?.issues).toBeUndefined();

	const entry = created.data;
	if (!entry) throw new Error('no entry');
	const saved = await folder.tables.captures.writeSource(
		entry,
		`${source}\n- a thought\n`,
	);
	expect(saved.error).toBeNull();
	await eventually(
		() => git(root, 'log', '--format=%s', '--', 'captures/one.md'),
		(log) => log.split('\n').filter(Boolean).length >= 1,
	);
	await eventually(
		() => git(root, 'status', '--porcelain'),
		(status) => status === '',
	);
	expect(await git(root, 'show', 'HEAD:captures/one.md')).toBe(
		`${source}\n- a thought`,
	);
});

test('a stale save is a Conflict with its fields, and the file is untouched', async () => {
	const { root, bridge } = await setup();
	const { folder } = await page(bridge);
	const created = await folder.tables.captures.create({
		stem: 'one',
		fields: { capturedAt: '2026-10-01T02:30:00.000Z' as never },
		body: '\nText\n',
	});
	const entry = created.data;
	if (!entry) throw new Error('no entry');
	await writeFile(join(root, 'captures/one.md'), 'edited by another program\n');

	const stale = await folder.tables.captures.writeSource(entry, 'mine');
	expect(stale.error?.name).toBe('Conflict');
	expect(stale.error).toMatchObject({ path: 'captures/one.md' });
	expect(await readFile(join(root, 'captures/one.md'), 'utf8')).toBe(
		'edited by another program\n',
	);
	const removed = await folder.tables.captures.delete(entry);
	expect(removed.error?.name).toBe('Conflict');
});

test.each([
	[
		'a symbolic link',
		async (root: string, parent: string) => {
			await mkdir(join(parent, 'elsewhere.git'));
			await symlink(join(parent, 'elsewhere.git'), join(root, '.git'));
		},
		'.git is a symbolic link',
	],
	[
		'a gitdir pointer file',
		(root: string, parent: string) =>
			writeFile(
				join(root, '.git'),
				`gitdir: ${join(parent, 'elsewhere.git')}\n`,
			),
		'.git is a file that points at another Git directory',
	],
] as const)('a directory whose .git is %s is refused before Git runs', async (_name, link, reason) => {
	const { parent, root, bridge } = await setup();
	await mkdir(root);
	await link(root, parent);
	const { status, reply } = await raw(bridge, {
		path: ['host', 'info'],
		args: [],
	});
	expect(status).toBe(500);
	expect('fault' in reply && reply.fault).toContain(reason);
	// Nothing was initialized through the link, and the lock was released.
	expect(await readdir(join(parent, 'elsewhere.git')).catch(() => [])).toEqual(
		[],
	);
	await rm(join(root, '.git'), { force: true });
	const retried = await raw(bridge, { path: ['host', 'info'], args: [] });
	expect(retried.status).toBe(200);
});

test('a raw write is exclusive, reads back, and is committed by the folder', async () => {
	const { root, bridge } = await setup();
	const { folder } = await page(bridge);
	const written = await folder.files.write('recovery/receipt.json', '{}\n', {
		expected: 'absent',
	});
	expect(written.error).toBeNull();
	const again = await folder.files.write('recovery/receipt.json', 'other', {
		expected: 'absent',
	});
	expect(again.error?.name).toBe('Conflict');
	const read = await folder.files.read('recovery/receipt.json');
	expect(new TextDecoder().decode(read.data?.bytes)).toBe('{}\n');
	expect((await folder.files.read('recovery/missing.json')).error?.name).toBe(
		'NotFound',
	);

	await eventually(
		() => git(root, 'status', '--porcelain'),
		(status) => status === '',
	);
	expect(await git(root, 'show', 'HEAD:recovery/receipt.json')).toBe('{}');
	expect((await folder.git.commit()).status).toBe('unchanged');
});

test.each([
	[
		'an unlisted method',
		{
			path: ['files', 'remove'],
			args: ['captures/one.md', { expected: 'any' }],
		},
	],
	['a terminal', { path: ['terminal', 'exec'], args: ['ls', '/'] }],
	[
		'a raw path outside captures and recovery',
		{
			path: ['files', 'write'],
			args: ['.git/config', 'x', { expected: 'absent' }],
		},
	],
	[
		'a nested capture path',
		{ path: ['files', 'read'], args: ['captures/a/b.md'] },
	],
	[
		'an unconditional overwrite',
		{
			path: ['files', 'write'],
			args: ['captures/one.md', 'x', { expected: 'any' }],
		},
	],
	['a malformed call', { path: 'files.read', args: [] }],
] as const)('%s is refused as a fault and runs nothing', async (_name, body) => {
	const { root, bridge } = await setup();
	const { status, reply } = await raw(bridge, body);
	expect(status).toBe(400);
	expect('fault' in reply).toBe(true);
	const config = Bun.file(join(root, '.git/config'));
	if (await config.exists()) expect(await config.text()).not.toBe('x');
	expect(await Bun.file(join(root, 'captures/one.md')).exists()).toBe(false);
});

test('an outside edit reaches the page as a hint to reread', async () => {
	const { root, bridge } = await setup();
	const { folder, onExternalChange } = await page(bridge);
	await folder.tables.captures.list();
	let hints = 0;
	onExternalChange(() => {
		hints++;
	});
	await Bun.sleep(60);
	await writeFile(
		join(root, 'captures/outside.md'),
		'---\ncapturedAt: 2026-10-01T02:30:00.000Z\n---\n\nFrom outside\n',
	);
	await eventually(
		async () => {
			await bridge.scan();
			return hints;
		},
		(count) => count > 0,
	);
	const listed = await folder.tables.captures.list();
	expect(listed.data?.entries.map((entry) => entry.path)).toEqual([
		'captures/outside.md',
	]);
});

test('a second owner of the same directory is refused, naming it', async () => {
	const { root, bridge } = await setup();
	await page(bridge);
	const second = createCaptureBridge({ root });
	cleanups.push(() => second.close());
	const { status, reply } = await raw(second, {
		path: ['host', 'info'],
		args: [],
	});
	expect(status).toBe(409);
	expect('fault' in reply && reply.fault).toContain(root);
});

test('a host that is gone is an Io Result for saves and a failed commit, never a throw', async () => {
	const { bridge } = await setup();
	const { folder } = await page(bridge);
	const created = await folder.tables.captures.create({
		stem: 'one',
		fields: { capturedAt: '2026-10-01T02:30:00.000Z' as never },
		body: '\nText\n',
	});
	const entry = created.data;
	if (!entry) throw new Error('no entry');
	await bridge.close();

	const saved = await folder.tables.captures.writeSource(entry, 'after close');
	expect(saved.error?.name).toBe('Io');
	expect(saved.error?.message).toContain('The Capture folder is closed.');
	expect((await folder.tables.captures.list()).error?.name).toBe('Io');
	expect((await folder.git.commit()).status).toBe('failed');
});
