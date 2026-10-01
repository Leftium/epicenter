/**
 * The folder host and the page's bridge client, end to end without a socket.
 *
 * The client's `fetch` is the host's `handle`, so every call here crosses the
 * real wire encoding and reaches a real directory and Git repository. What
 * these establish: the bridged folder behaves like the native folder, the
 * debug failures are repeatable and leave the documented state on disk, the
 * terminal runs in the data folder and keeps its directory, and none of it is
 * reachable without the launch token.
 */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectFolder } from '../src/lib/bridge/folder-client.js';
import { createHttpBridge } from '../src/lib/bridge/http.js';
import { toneWav } from '../src/lib/capture.js';
import {
	type RecordingFields,
	whisperingDefinition,
} from '../src/lib/definition.js';
import {
	type PendingCapture,
	publishRecording,
} from '../src/lib/recordings/publish.js';
import { createHost, type Host, type HostOptions } from './host.js';
import type { ShellRun } from './terminal.js';

const TOKEN = 'test-token';
const ORIGIN = 'http://127.0.0.1:4999';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(overrides: Partial<HostOptions> = {}) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-host-')),
	);
	const root = join(directory, 'data');
	const host: Host = await createHost({
		root,
		token: TOKEN,
		uiDist: undefined,
		debug: true,
		fixturePath: undefined,
		inlineToken: false,
		env: {},
		log: () => {},
		...overrides,
	});
	host.listening(4999);
	const bridge = createHttpBridge({
		origin: ORIGIN,
		token: TOKEN,
		fetch: (input, init) => host.handle(new Request(input, init)),
	});
	const remote = await connectFolder(whisperingDefinition, bridge.transport);
	cleanups.push(async () => {
		await remote.folder.close();
		await host.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, root: host.root, host, bridge, remote };
}

function capture(id = '20260102-030405-abcd'): PendingCapture {
	return {
		id,
		bytes: toneWav(),
		extension: 'wav',
		fields: {
			title: 'First take',
			recordedAt: '2026-01-02T03:04:05.000Z',
			durationMs: 1000,
			capture: 'fixture',
		} as RecordingFields,
	};
}

const git = (root: string, ...args: string[]) =>
	execFileSync('git', args, { cwd: root, encoding: 'utf8' });

test('the bridge answers nothing without the launch token or under another name', async () => {
	const { host } = await start();
	const call = (headers: Record<string, string>) =>
		host.handle(
			new Request(`${ORIGIN}/bridge/call`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ path: ['files', 'list'], args: [] }),
			}),
		);

	expect((await call({})).status).toBe(401);
	expect((await call({ authorization: 'Bearer wrong-token' })).status).toBe(
		401,
	);
	expect(
		(
			await call({
				authorization: `Bearer ${TOKEN}`,
				host: 'evil.example:4999',
			})
		).status,
	).toBe(403);
	expect(
		(
			await call({
				authorization: `Bearer ${TOKEN}`,
				origin: 'https://evil.example',
			})
		).status,
	).toBe(403);
	expect((await call({ authorization: `Bearer ${TOKEN}` })).status).toBe(200);
});

test('only folder methods can be called', async () => {
	const { bridge } = await start();
	await expect(
		bridge.transport.call(['git', 'constructor'], []),
	).rejects.toThrow();
	await expect(
		bridge.transport.call(['tables', '__proto__', 'list'], []),
	).rejects.toThrow();
});

test('a recording published through the bridge is real files and real history', async () => {
	const { root, remote } = await start();
	const pending = capture();

	const outcome = await publishRecording(remote.folder, pending);

	expect(outcome.status).toBe('saved');
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	const opened = await remote.folder.files.open(`recordings/${pending.id}.wav`);
	expect(opened.error).toBeNull();
	expect(new Uint8Array(await opened.data!.arrayBuffer())).toEqual(
		new Uint8Array(pending.bytes),
	);

	const committed = await remote.folder.git.commit();
	expect(['committed', 'unchanged']).toContain(committed.status);
	expect(
		git(root, 'log', '--oneline').trim().split('\n').length,
	).toBeGreaterThan(0);
	expect(
		new Uint8Array(
			execFileSync(
				'git',
				['cat-file', 'blob', `HEAD:recordings/${pending.id}.wav`],
				{ cwd: root },
			),
		),
	).toEqual(new Uint8Array(pending.bytes));
});

test('an entry read through the bridge can be written back, and a stale one conflicts', async () => {
	const { root, remote } = await start();
	const pending = capture();
	await publishRecording(remote.folder, pending);
	const table = remote.folder.tables.recordings;
	const listed = await table.list();
	const entry = listed.data!.entries[0]!;
	expect(entry.issues).toBeUndefined();

	const renamed = await table.update(entry, { fields: { title: 'Renamed' } });
	expect(renamed.error).toBeNull();
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toContain('title: Renamed');

	// The first observation is now stale: its write must be refused, not applied.
	const stale = await table.update(entry, { fields: { title: 'Lost update' } });
	expect(stale.error?.name).toBe('Conflict');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toContain('title: Renamed');
});

test('unknown frontmatter and a malformed row survive the bridge untouched', async () => {
	const { root, remote } = await start();
	await mkdir(join(root, 'recordings'), { recursive: true });
	const odd =
		'---\n# kept comment\ntitle: Odd\nrecordedAt: 2026-01-02T03:04:05.000Z\ndurationMs: 5\ncapture: microphone\nmood: curious\n---\nNotes\n';
	const broken = '---\ntitle: *missing\n---\nStill here\n';
	await writeFile(join(root, 'recordings', 'odd.md'), odd);
	await writeFile(join(root, 'recordings', 'broken.md'), broken);

	const listed = await remote.folder.tables.recordings.list();
	const byPath = new Map(
		listed.data!.entries.map((entry) => [entry.path, entry]),
	);
	const brokenEntry = byPath.get('recordings/broken.md')!;
	expect(brokenEntry.issues?.[0]?.kind).toBe('frontmatter');
	expect(brokenEntry.source).toBe(broken);

	const oddEntry = byPath.get('recordings/odd.md')!;
	const updated = await remote.folder.tables.recordings.update(oddEntry, {
		fields: { title: 'Odd, renamed' },
	});
	expect(updated.error).toBeNull();
	const after = await readFile(join(root, 'recordings', 'odd.md'), 'utf8');
	expect(after).toContain('# kept comment');
	expect(after).toContain('mood: curious');
	expect(after).toContain('title: Odd, renamed');
	expect(await readFile(join(root, 'recordings', 'broken.md'), 'utf8')).toBe(
		broken,
	);
});

test('an injected row failure leaves the audio saved, and retry completes one recording', async () => {
	const { root, bridge, remote } = await start();
	const pending = capture();
	await bridge.app('inject', { rowWrites: 2 });

	const first = await publishRecording(remote.folder, pending);
	expect(first.status).toBe('partial');
	if (first.status === 'partial')
		expect(first.landed).toEqual([`recordings/${pending.id}.wav`]);
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.wav`,
	]);

	// The second armed failure hits the recovery write; the audio stays put.
	const second = await publishRecording(remote.folder, pending);
	expect(second.status).toBe('partial');
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.wav`,
	]);

	const third = await publishRecording(remote.folder, pending);
	expect(third.status).toBe('saved');
	if (third.status === 'saved') expect(third.recovered).toBe(true);
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	const listed = await remote.folder.tables.recordings.list();
	expect(listed.data!.entries).toHaveLength(1);
	expect(listed.data!.entries[0]!.issues).toBeUndefined();
});

test('an injected audio failure writes nothing, and retry saves', async () => {
	const { root, bridge, remote } = await start();
	const pending = capture();
	await bridge.app('inject', { audioWrites: 1 });

	const first = await publishRecording(remote.folder, pending);
	expect(first.status).toBe('failed');
	expect(
		await readdir(join(root, 'recordings')).catch(() => [] as string[]),
	).toEqual([]);

	const second = await publishRecording(remote.folder, pending);
	expect(second.status).toBe('saved');
	if (second.status === 'saved') expect(second.recovered).toBe(false);
});

test('a locked branch fails the commit and never the save; unlocking lets it commit', async () => {
	const { root, bridge, remote } = await start();
	const pending = capture();
	await bridge.app('inject', { commitsBlocked: true });

	const outcome = await publishRecording(remote.folder, pending);
	expect(outcome.status).toBe('saved');
	const blocked = await remote.folder.git.commit();
	expect(blocked.status).not.toBe('committed');
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	expect(() => git(root, 'rev-parse', '--verify', 'HEAD')).toThrow();

	await bridge.app('inject', { commitsBlocked: false });
	const committed = await remote.folder.git.commit();
	expect(committed.status).toBe('committed');
	expect(
		git(root, 'ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort(),
	).toEqual([`recordings/${pending.id}.md`, `recordings/${pending.id}.wav`]);
});

test('the terminal runs in the data folder, edits its files, and keeps its directory', async () => {
	const { root, bridge } = await start();
	const run = (command: string, cwd: string) =>
		bridge.app<ShellRun>('terminal', { command, cwd });

	const written = await run(
		'mkdir -p recordings && printf hello > note.md && pwd -P',
		'',
	);
	expect(written.exitCode).toBe(0);
	expect(written.stdout.trim()).toBe(root);
	expect(await readFile(join(root, 'note.md'), 'utf8')).toBe('hello');

	const moved = await run('cd recordings', written.cwd);
	expect(moved.cwd).toBe('recordings');
	const inside = await run('pwd -P', moved.cwd);
	expect(inside.stdout.trim()).toBe(join(root, 'recordings'));
	expect(inside.cwd).toBe('recordings');

	const failed = await run('ls does-not-exist', inside.cwd);
	expect(failed.exitCode).not.toBe(0);
	expect(failed.stderr).not.toBe('');
	expect(failed.cwd).toBe('recordings');

	const escaped = await run('cd /', inside.cwd);
	expect(escaped.cwd).toBe('');
	expect(escaped.stderr).toContain('stays inside the data folder');

	const history = await run('git status --short', '');
	expect(history.exitCode).toBe(0);
	expect(history.stdout).toContain('note.md');
});

test('a change made outside the app is announced on the event stream', async () => {
	const { root, remote } = await start();
	const seen = new Promise<void>((resolve) => remote.onExternalChange(resolve));
	// Give the stream a moment to connect before the outside write.
	await new Promise((resolve) => setTimeout(resolve, 150));
	await writeFile(join(root, 'outside.md'), 'written by another program\n');
	await Promise.race([
		seen,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error('no change event arrived')), 5000),
		),
	]);
	const listing = await remote.folder.files.list();
	expect(listing.data!.files.map((file) => file.path)).toContain('outside.md');
});

test('transcription reads the saved audio and sends it to the configured endpoint', async () => {
	const requests: {
		url: string;
		authorization: string | null;
		form: FormData;
	}[] = [];
	const { bridge, remote } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: 'local-test-key' },
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
				form: await request.formData(),
			});
			return Response.json({ text: 'a steady tone' });
		},
	});
	const pending = capture();
	await publishRecording(remote.folder, pending);

	const result = await bridge.app<{
		data: { text: string } | null;
		error: unknown;
	}>('transcribe', {
		path: `recordings/${pending.id}.wav`,
		baseUrl: 'http://127.0.0.1:18080/v1/',
		model: 'verification-model',
	});

	expect(result.error).toBeNull();
	expect(result.data?.text).toBe('a steady tone');
	expect(requests).toHaveLength(1);
	expect(requests[0]!.url).toBe(
		'http://127.0.0.1:18080/v1/audio/transcriptions',
	);
	expect(requests[0]!.authorization).toBe('Bearer local-test-key');
	expect(requests[0]!.form.get('model')).toBe('verification-model');
	const file = requests[0]!.form.get('file') as File;
	expect(file.name).toBe(`${pending.id}.wav`);
	expect(new Uint8Array(await file.arrayBuffer())).toEqual(
		new Uint8Array(pending.bytes),
	);
});

test('fixture audio and failure injection exist only in a debug shell', async () => {
	const fixtureDirectory = await mkdtemp(join(tmpdir(), 'whispering-fixture-'));
	cleanups.push(() => rm(fixtureDirectory, { recursive: true, force: true }));
	const fixturePath = join(fixtureDirectory, 'tone.wav');
	await writeFile(fixturePath, toneWav());

	const debug = await start({ fixturePath });
	const info = await debug.bridge.app<{
		fixture: { name: string; size: number } | null;
		fixtureRefused: boolean;
	}>('info');
	expect(info.fixture).toEqual({ name: 'tone.wav', size: toneWav().length });
	expect(info.fixtureRefused).toBe(false);
	const taken = await debug.bridge.app<{ name: string; bytes: Uint8Array }>(
		'fixture',
	);
	expect(taken.bytes).toEqual(toneWav());

	const release = await start({ fixturePath, debug: false });
	const releaseInfo = await release.bridge.app<{
		fixture: unknown;
		fixtureRefused: boolean;
	}>('info');
	expect(releaseInfo.fixture).toBeNull();
	expect(releaseInfo.fixtureRefused).toBe(true);
	await expect(release.bridge.app('fixture')).rejects.toThrow();
	await expect(
		release.bridge.app('inject', { rowWrites: 1 }),
	).rejects.toThrow();
});

test('the device transcription key is kept out of the versioned folder', async () => {
	const { root, bridge, remote } = await start();
	await bridge.app('credential', { key: 'secret-key' });
	const info = await bridge.app<{ credentialPresent: boolean }>('info');
	expect(info.credentialPresent).toBe(true);

	const listing = await remote.folder.files.list();
	for (const file of listing.data!.files)
		expect(
			await readFile(join(root, file.path), 'utf8').catch(() => ''),
		).not.toContain('secret-key');
	expect(
		await readFile(
			join(root, '.git', 'epicenter', 'whispering', 'device.json'),
			'utf8',
		),
	).toContain('secret-key');
});

test('the page is served with the token only in standalone mode, and paths stay inside it', async () => {
	const dist = await mkdtemp(join(tmpdir(), 'whispering-dist-'));
	cleanups.push(() => rm(dist, { recursive: true, force: true }));
	await writeFile(
		join(dist, 'index.html'),
		'<html><head></head><body></body></html>',
	);
	await writeFile(join(dist, '..', 'outside-secret.txt'), 'secret').catch(
		() => {},
	);
	const get = (host: Host, path: string) =>
		host.handle(new Request(`${ORIGIN}${path}`));

	const shell = await start({ uiDist: dist });
	const index = await get(shell.host, '/');
	expect(index.status).toBe(200);
	expect(await index.text()).not.toContain(TOKEN);
	expect((await get(shell.host, '/recordings/anything')).status).toBe(200);
	expect((await get(shell.host, '/_app/missing.js')).status).toBe(404);
	expect((await get(shell.host, '/%2e%2e/outside-secret.txt')).status).toBe(
		404,
	);

	const standalone = await start({ uiDist: dist, inlineToken: true });
	expect(await (await get(standalone.host, '/')).text()).toContain(TOKEN);
});
