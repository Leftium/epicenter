/**
 * The Whispering host and the page's bridge to it, end to end without a socket.
 *
 * The bridge's `fetch` is the host's `handle`, so every call here crosses the
 * real wire encoding and reaches a real directory. What these establish: the
 * host holds no folder and takes no part in owning one, it reads audio and
 * runs the terminal as an ordinary program in the directory it is given, the
 * debug failures are repeatable and leave the documented state on disk, the
 * key stays in the host, and none of it is reachable without the launch token.
 *
 * Where a test needs something to publish and commit, it opens the directory
 * with the Bun directory opener. That is a stand-in for the desktop shell's
 * Rust owner, which this process cannot start: it shows the host's obstacles
 * make a real folder fail its own step, not how the Rust owner reports it.
 */
import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
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
import { expectErr } from 'wellcrafted/testing';
import { createHttpBridge } from '../src/lib/bridge/http.js';
import { toneWav } from '../src/lib/capture.js';
import type { RecordingFields } from '../src/lib/definition.js';
import {
	type PendingCapture,
	publishRecording,
} from '../src/lib/recordings/publish.js';
import type { RecordingPublicationHook } from '../src/lib/workspace/types.js';
import { openTestFolder } from '../src/lib/workspace.test-support.js';
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
	// The shell creates and resolves the folder before it starts the host.
	const root = join(directory, 'data');
	await mkdir(root);
	const host: Host = await createHost({
		root,
		token: TOKEN,
		uiDist: undefined,
		debug: true,
		fixturePath: undefined,
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
	cleanups.push(async () => {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	});
	return { directory, root, host, bridge };
}

/** The folder's owner, for a test that needs files published and committed. */
async function owner(root: string) {
	const folder = await openTestFolder(root, { commitOnEdit: false });
	cleanups.push(() => folder.close());
	return folder;
}

/** What the desktop workspace does around a recording's batch in a debug shell. */
function obstacles(
	bridge: ReturnType<typeof createHttpBridge>,
): RecordingPublicationHook {
	return async (recording, publish) => {
		const { obstacle } = await bridge.app<{ obstacle: string | null }>(
			'obstruct',
			recording,
		);
		try {
			return await publish();
		} finally {
			if (obstacle !== null) await bridge.app('unobstruct', { obstacle });
		}
	};
}

function capture(id = '20260102-030405-abcd'): PendingCapture {
	return {
		id,
		bytes: toneWav(),
		fields: {
			title: 'First take',
			recordedAt: '2026-01-02T03:04:05.000Z',
			durationMs: 1000,
			capture: 'fixture',
			audioPath: `recordings/${id}.wav`,
		} as RecordingFields,
		body: '',
	};
}

const post = (host: Host, path: string, body: unknown, headers = {}) =>
	host.handle(
		new Request(`${ORIGIN}${path}`, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${TOKEN}`,
				...headers,
			},
			body: JSON.stringify(body),
		}),
	);

/** An endpoint stub that records what it was sent. */
function endpoint(
	answer: (request: Request) => Response | Promise<Response> = () =>
		Response.json({ text: 'a steady tone' }),
) {
	const requests: {
		url: string;
		authorization: string | null;
		form: FormData;
	}[] = [];
	return {
		requests,
		fetch: async (input: string, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push({
				url: request.url,
				authorization: request.headers.get('authorization'),
				form: await request.clone().formData(),
			});
			return answer(request);
		},
	};
}

const transcribeRequest = (path: string) => ({
	path,
	baseUrl: 'http://127.0.0.1:18080/v1/',
	model: 'verification-model',
});

type Transcribed = {
	data: { text: string } | null;
	error: { name: string; message: string } | null;
};

test('the bridge answers nothing without the launch token or under another name', async () => {
	const { host } = await start();
	const call = (headers: Record<string, string>) =>
		host.handle(
			new Request(`${ORIGIN}/bridge/app`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body: JSON.stringify({ op: 'info', payload: {} }),
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

test('the host has no folder route, no folder operation, and no folder', async () => {
	const { host } = await start();

	// The generic folder call is gone, with the token and without it.
	const call = await post(host, '/bridge/call', {
		path: ['files', 'list'],
		args: [],
	});
	expect(call.status).toBe(404);
	expect(await call.json()).toEqual({ fault: 'Not found' });
	// Nothing folder-shaped is an application operation either.
	for (const op of [
		'batch',
		'files.read',
		'git.commit',
		'tables',
		'openFolder',
	])
		expect((await post(host, '/bridge/app', { op, payload: {} })).status).toBe(
			500,
		);
	expect('folder' in host).toBe(false);
});

test('the host works beside a held folder lock and leaves the directory exactly as it was given', async () => {
	const stub = endpoint();
	const { directory, root, host, bridge } = await start({ fetch: stub.fetch });
	// The lock the shell's owner holds for as long as it has the folder: an
	// exclusive transaction on this file beside the directory.
	const lock = new Database(join(directory, '.data.epicenter-lock'));
	cleanups.push(async () => lock.close());
	lock.run('BEGIN EXCLUSIVE');

	const info = await bridge.app<{ root: string }>('info');
	expect(info.root).toBe(root);
	const stream = await host.handle(
		new Request(`${ORIGIN}/bridge/events`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	await stream.body?.cancel();
	// While the lock is held, the host reads audio and runs its shell.
	await writeFile(join(root, 'take.wav'), toneWav());
	const transcribed = await bridge.app<Transcribed>(
		'transcribe',
		transcribeRequest('take.wav'),
	);
	expect(transcribed.data?.text).toBe('a steady tone');
	const run = await bridge.app<ShellRun>('terminal', {
		command: 'ls',
		cwd: '',
	});
	expect(run.exitCode).toBe(0);
	expect(run.stdout.trim()).toBe('take.wav');
	await host.close();

	// No repository, no settings file, no index: only what the test wrote.
	expect(await readdir(root)).toEqual(['take.wav']);
	// And the host never asked for the lock: its holder still has it.
	const second = new Database(join(directory, '.data.epicenter-lock'));
	cleanups.push(async () => second.close());
	second.run('PRAGMA busy_timeout = 0');
	expect(() => second.run('BEGIN EXCLUSIVE')).toThrow();
	// Beside the folder there is only the lock this test took, and its journal.
	expect(
		(await readdir(directory)).filter(
			(name) => !name.startsWith('.data.epicenter-lock'),
		),
	).toEqual(['data']);
});

test('a host is given the shell’s resolved directory, and refuses anything else without creating it', async () => {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-root-')),
	);
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	await mkdir(join(directory, 'real'));
	await symlink(join(directory, 'real'), join(directory, 'alias'));
	await writeFile(join(directory, 'file'), 'not a directory');
	const open = (root: string) =>
		createHost({
			root,
			token: TOKEN,
			uiDist: undefined,
			debug: false,
			fixturePath: undefined,
			env: {},
			log: () => {},
		});

	for (const root of [
		join(directory, 'missing'),
		join(directory, 'alias'),
		join(directory, 'file'),
		`${directory}/real/../real`,
		`${directory}/real/`,
		'relative/data',
		'',
	])
		await expect(open(root)).rejects.toThrow('does not choose or create one');

	expect((await readdir(directory)).sort()).toEqual(['alias', 'file', 'real']);
	const host = await open(join(directory, 'real'));
	expect(host.root).toBe(join(directory, 'real'));
	await host.close();
});

test('an injected row failure leaves the audio saved, and retry completes one recording', async () => {
	const { root, bridge } = await start();
	const folder = await owner(root);
	const around = obstacles(bridge);
	const pending = capture();
	await bridge.app('inject', { rowWrites: 2 });

	const first = await publishRecording(folder, pending, around);
	expect(first.status).toBe('partial');
	if (first.status === 'partial') {
		expect(first.landed).toEqual([`recordings/${pending.id}.wav`]);
		// The failure is the folder's own report of its own step, not an invented one.
		expect(first.message).toBe(
			`'recordings/${pending.id}.md' is a directory, not a file`,
		);
	}
	// The audio is the captured bytes, and the obstruction is gone again.
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.wav`,
	]);
	expect(
		new Uint8Array(
			await readFile(join(root, 'recordings', `${pending.id}.wav`)),
		),
	).toEqual(new Uint8Array(pending.bytes));
	expect((await bridge.app<{ rowWrites: number }>('injection')).rowWrites).toBe(
		1,
	);

	// The second armed failure hits the recovery batch, which replaces the
	// audio it read with the same bytes and fails at the row. The audio stays put.
	const second = await publishRecording(folder, pending, around);
	expect(second.status).toBe('partial');
	if (second.status === 'partial')
		expect(second.landed).toEqual([`recordings/${pending.id}.wav`]);
	expect(await readdir(join(root, 'recordings'))).toEqual([
		`${pending.id}.wav`,
	]);

	const third = await publishRecording(folder, pending, around);
	expect(third.status).toBe('saved');
	if (third.status === 'saved') {
		expect(third.recovered).toBe(true);
		expect(third.entry.fields).toEqual(pending.fields);
	}
	expect(
		new Uint8Array(
			await readFile(join(root, 'recordings', `${pending.id}.wav`)),
		),
	).toEqual(new Uint8Array(pending.bytes));
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	const listed = await folder.tables.recordings.list();
	expect(listed.data!.entries).toHaveLength(1);
	expect(listed.data!.entries[0]!.issues).toBeUndefined();
});

test('an injected audio failure writes nothing, and retry saves', async () => {
	const { root, bridge } = await start();
	const folder = await owner(root);
	const around = obstacles(bridge);
	const pending = capture();
	await bridge.app('inject', { audioWrites: 1 });

	const first = await publishRecording(folder, pending, around);
	expect(first.status).toBe('failed');
	expect(
		await readdir(join(root, 'recordings')).catch(() => [] as string[]),
	).toEqual([]);

	const second = await publishRecording(folder, pending, around);
	expect(second.status).toBe('saved');
	if (second.status === 'saved') expect(second.recovered).toBe(false);
});

test('an armed failure leaves a path that is already occupied alone, and is not spent on it', async () => {
	const { root, bridge } = await start();
	const folder = await owner(root);
	const pending = capture();
	const foreign = '---\ntitle: Someone else\n---\nKeep me\n';
	await mkdir(join(root, 'recordings'), { recursive: true });
	await writeFile(join(root, 'recordings', `${pending.id}.md`), foreign);
	await bridge.app('inject', { rowWrites: 1 });

	// The page's own check refuses before any batch, so no obstacle is asked for.
	let asked = 0;
	const counting: RecordingPublicationHook = (recording, publish) => {
		asked += 1;
		return obstacles(bridge)(recording, publish);
	};
	expect((await publishRecording(folder, pending, counting)).status).toBe(
		'unexpected',
	);
	expect(asked).toBe(0);
	// Asked for directly, the occupied row is left alone, and the folder refuses the batch itself.
	const refused = expectErr(
		await obstacles(bridge)(
			{ stem: pending.id, audioPath: pending.fields.audioPath },
			() =>
				folder.batch((batch) => {
					batch.files.create(pending.fields.audioPath, pending.bytes);
					batch.tables.recordings.create({
						stem: pending.id,
						fields: pending.fields,
					});
				}),
		),
	);

	expect(refused.name).toBe('Exists');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toBe(foreign);
	expect(await readdir(join(root, 'recordings'))).toEqual([`${pending.id}.md`]);
	expect((await bridge.app<{ rowWrites: number }>('injection')).rowWrites).toBe(
		1,
	);
});

test('a locked branch fails the commit and never the save; unlocking lets it commit', async () => {
	const { root, bridge } = await start({
		env: { WHISPERING_DEBUG_BLOCK_COMMITS: '1' },
	});
	const git = (...args: string[]) =>
		execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
	// Asked for at launch, and not taken: the folder has not been opened.
	expect(
		(await bridge.app<{ commitsBlocked: boolean }>('injection')).commitsBlocked,
	).toBe(false);
	expect(await readdir(root)).toEqual([]);

	const folder = await owner(root);
	// The page says the owner has opened the folder; the lock is taken now.
	expect(
		(await bridge.app<{ commitsBlocked: boolean }>('injection-launch'))
			.commitsBlocked,
	).toBe(true);
	const pending = capture();

	const outcome = await publishRecording(folder, pending, obstacles(bridge));
	expect(outcome.status).toBe('saved');
	const blocked = await folder.git.commit();
	expect(blocked.status).not.toBe('committed');
	expect((await readdir(join(root, 'recordings'))).sort()).toEqual([
		`${pending.id}.md`,
		`${pending.id}.wav`,
	]);
	expect(() => git('rev-parse', '--verify', 'HEAD')).toThrow();

	await bridge.app('inject', { commitsBlocked: false });
	const committed = await folder.git.commit();
	expect(committed.status).toBe('committed');
	expect(
		git('ls-tree', '-r', '--name-only', 'HEAD').trim().split('\n').sort(),
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
});

test('a terminal edit is an outside write: the owner’s next read sees it, and a save over the older version conflicts', async () => {
	const { root, bridge } = await start();
	const folder = await owner(root);
	const pending = capture();
	await publishRecording(folder, pending);
	const entry = (await folder.tables.recordings.get(pending.id)).data!;
	expect((await folder.git.commit()).status).toBe('committed');

	// The real shell, as any other program: it edits the row and commits.
	const run = await bridge.app<ShellRun>('terminal', {
		command: `sed -i.bak 's/First take/Renamed in the shell/' recordings/${pending.id}.md && rm recordings/${pending.id}.md.bak && git status --short`,
		cwd: '',
	});
	expect(run.exitCode).toBe(0);
	expect(run.stdout).toContain(`recordings/${pending.id}.md`);

	const reread = (await folder.tables.recordings.get(pending.id)).data!;
	expect(reread.fields.title).toBe('Renamed in the shell');
	// The page's older observation no longer matches: its save is refused, not applied.
	const stale = await folder.tables.recordings.replace(
		entry,
		entry.source.replace('First take', 'Lost update'),
	);
	expect(stale.error?.name).toBe('Conflict');
	expect(
		await readFile(join(root, 'recordings', `${pending.id}.md`), 'utf8'),
	).toContain('title: Renamed in the shell');
});

test('transcription reads the saved audio and sends it to the configured endpoint', async () => {
	const stub = endpoint();
	const { root, bridge } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: 'local-test-key' },
		fetch: stub.fetch,
	});
	const pending = capture();
	await publishRecording(await owner(root), pending);

	const result = await bridge.app<Transcribed>(
		'transcribe',
		transcribeRequest(`recordings/${pending.id}.wav`),
	);

	expect(result.error).toBeNull();
	expect(result.data?.text).toBe('a steady tone');
	expect(stub.requests).toHaveLength(1);
	expect(stub.requests[0]!.url).toBe(
		'http://127.0.0.1:18080/v1/audio/transcriptions',
	);
	expect(stub.requests[0]!.authorization).toBe('Bearer local-test-key');
	expect(stub.requests[0]!.form.get('model')).toBe('verification-model');
	const file = stub.requests[0]!.form.get('file') as File;
	expect(file.name).toBe(`${pending.id}.wav`);
	expect(new Uint8Array(await file.arrayBuffer())).toEqual(
		new Uint8Array(pending.bytes),
	);
});

test('audio at a nested path the row names is sent once, under its own name and type', async () => {
	const stub = endpoint();
	const { root, bridge } = await start({ fetch: stub.fetch });
	const bytes = new Uint8Array([
		0, 0, 0, 24, 102, 116, 121, 112, 77, 52, 65, 32,
	]);
	await mkdir(join(root, 'Imported', '2026 takes'), { recursive: true });
	await writeFile(
		join(root, 'Imported', '2026 takes', 'Voice Memo.m4a'),
		bytes,
	);

	const result = await bridge.app<Transcribed>(
		'transcribe',
		transcribeRequest('Imported/2026 takes/Voice Memo.m4a'),
	);

	expect(result.data?.text).toBe('a steady tone');
	expect(stub.requests).toHaveLength(1);
	const file = stub.requests[0]!.form.get('file') as File;
	expect(file.name).toBe('Voice Memo.m4a');
	expect(file.type).toBe('audio/x-m4a');
	expect(new Uint8Array(await file.arrayBuffer())).toEqual(bytes);
	// No key is configured, so none is sent.
	expect(stub.requests[0]!.authorization).toBeNull();
});

test('the bytes sent are the ones read: changing or removing the file during the request changes nothing', async () => {
	const arrived = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let sent: Uint8Array | undefined;
	const { root, bridge } = await start({
		fetch: async (input, init) => {
			const request = new Request(input, init);
			arrived.resolve();
			// The endpoint is slow to read the upload.
			await release.promise;
			const file = (await request.formData()).get('file') as File;
			sent = new Uint8Array(await file.arrayBuffer());
			return Response.json({ text: 'a steady tone' });
		},
	});
	const original = toneWav();
	await mkdir(join(root, 'recordings'));
	await writeFile(join(root, 'recordings', 'take.wav'), original);

	const transcribing = bridge.app<Transcribed>(
		'transcribe',
		transcribeRequest('recordings/take.wav'),
	);
	await arrived.promise;
	await writeFile(join(root, 'recordings', 'take.wav'), 'replaced meanwhile');
	await rm(join(root, 'recordings', 'take.wav'));
	release.resolve();

	expect((await transcribing).data?.text).toBe('a steady tone');
	expect(sent).toEqual(new Uint8Array(original));
});

test('a path that cannot be read as the folder’s own regular file sends nothing', async () => {
	const stub = endpoint();
	const { directory, root, bridge } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: 'local-test-key' },
		fetch: stub.fetch,
	});
	const outside = join(directory, 'outside');
	await mkdir(outside);
	await writeFile(join(outside, 'secret.wav'), 'outside the folder');
	await mkdir(join(root, 'recordings'));
	await mkdir(join(root, '.git'));
	await writeFile(join(root, '.git', 'config'), 'private');
	await writeFile(join(root, 'recordings', 'take.wav'), toneWav());
	await symlink(
		join(root, 'recordings', 'take.wav'),
		join(root, 'recordings', 'inside-link.wav'),
	);
	await symlink(
		join(outside, 'secret.wav'),
		join(root, 'recordings', 'outside-link.wav'),
	);
	await symlink(join(root, 'recordings'), join(root, 'alias'));
	await symlink(outside, join(root, 'elsewhere'));
	execFileSync('mkfifo', [join(root, 'recordings', 'pipe.wav')]);

	for (const path of [
		'',
		'../outside/secret.wav',
		'recordings/../../outside/secret.wav',
		join(outside, 'secret.wav'),
		'recordings\\take.wav',
		'recordings//take.wav',
		'./recordings/take.wav',
		'recordings/take\n.wav',
		'.git/config',
		'.GIT/config',
		'Recordings/take.wav',
		'recordings/TAKE.wav',
		'recordings/inside-link.wav',
		'recordings/outside-link.wav',
		'alias/take.wav',
		'elsewhere/secret.wav',
		'recordings/gone.wav',
		'recordings',
		'recordings/take.wav/inner.wav',
		'recordings/pipe.wav',
	]) {
		const result = await bridge.app<Transcribed>(
			'transcribe',
			transcribeRequest(path),
		);
		expect(result.data).toBeNull();
		expect(result.error?.name).toBe('AudioUnreadable');
	}

	expect(stub.requests).toEqual([]);
});

test('a transcription refusal that echoes the key reaches the page without it', async () => {
	const { root, host } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: 'local-test-key' },
		fetch: async (input, init) =>
			Response.json(
				{
					error: `Bad credential: ${new Request(input, init).headers.get('authorization')}`,
				},
				{ status: 401 },
			),
	});
	await writeFile(join(root, 'take.wav'), toneWav());

	const answered = await post(host, '/bridge/app', {
		op: 'transcribe',
		payload: {
			path: 'take.wav',
			baseUrl: 'http://127.0.0.1:18080/v1',
			model: 'verification-model',
		},
	});
	const answer = await answered.text();

	expect(JSON.parse(answer)).toMatchObject({
		ok: { data: null, error: { name: 'Rejected', status: 401 } },
	});
	expect(answer).toContain('Bad credential');
	expect(answer).not.toContain('local-test-key');
});

test('a transformation is sent by the host with the device key, which never reaches the page', async () => {
	const requests: {
		url: string;
		authorization: string | null;
		body: unknown;
	}[] = [];
	let refuse = false;
	const { root, bridge, host } = await start({
		fetch: async (input, init) => {
			const request = new Request(input, init);
			const authorization = request.headers.get('authorization');
			requests.push({
				url: request.url,
				authorization,
				body: await request.json(),
			});
			// A deterministic local endpoint; a refusal echoes the credential it was sent.
			if (refuse)
				return Response.json(
					{ error: { message: `Bad credential: ${authorization}` } },
					{ status: 401 },
				);
			return Response.json({
				choices: [
					{ message: { role: 'assistant', content: 'A steady tone.' } },
				],
			});
		},
	});
	await bridge.app('credential', { key: 'device-secret-key' });
	const send = () =>
		post(host, '/bridge/app', {
			op: 'transform',
			payload: {
				baseUrl: 'http://127.0.0.1:18080/v1/',
				model: 'chat-model',
				prompt: 'Fix the punctuation.',
				input: 'um so a steady tone',
			},
		});

	const answered = await send();
	const answer = await answered.text();

	expect(answered.status).toBe(200);
	expect(JSON.parse(answer)).toMatchObject({
		ok: { data: { text: 'A steady tone.' }, error: null },
	});
	expect(requests).toEqual([
		{
			url: 'http://127.0.0.1:18080/v1/chat/completions',
			authorization: 'Bearer device-secret-key',
			body: {
				model: 'chat-model',
				messages: [
					{ role: 'system', content: 'Fix the punctuation.' },
					{ role: 'user', content: 'um so a steady tone' },
				],
			},
		},
	]);
	// The page's copy of the answer has the text and nothing of the key.
	expect(answer).not.toContain('device-secret-key');

	refuse = true;
	const refused = await (await send()).text();
	expect(JSON.parse(refused)).toMatchObject({
		ok: { data: null, error: { name: 'Rejected', status: 401 } },
	});
	expect(refused).not.toContain('device-secret-key');

	// A request is not a save: only the key's own file, under `.git`, was written.
	expect(await readdir(root)).toEqual(['.git']);
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

	// A release shell arms nothing, whatever the environment says.
	const release = await start({
		fixturePath,
		debug: false,
		env: {
			WHISPERING_DEBUG_FAIL_ROW_WRITES: '3',
			WHISPERING_DEBUG_BLOCK_COMMITS: '1',
		},
	});
	const releaseInfo = await release.bridge.app<{
		fixture: unknown;
		fixtureRefused: boolean;
	}>('info');
	expect(releaseInfo.fixture).toBeNull();
	expect(releaseInfo.fixtureRefused).toBe(true);
	await expect(release.bridge.app('fixture')).rejects.toThrow();
	for (const [op, payload] of [
		['inject', { rowWrites: 1 }],
		['injection', {}],
		['injection-launch', {}],
		['obstruct', { stem: 'take', audioPath: 'recordings/take.wav' }],
		['unobstruct', { obstacle: 'any' }],
	] as const)
		await expect(release.bridge.app(op, payload)).rejects.toThrow(
			'only available in a debug shell',
		);
	expect(await readdir(release.root)).toEqual([]);
});

test('the device transcription key is kept out of the versioned folder', async () => {
	const { root, bridge } = await start();
	const folder = await owner(root);
	await bridge.app('credential', { key: 'secret-key' });
	const info = await bridge.app<{ credentialPresent: boolean }>('info');
	expect(info.credentialPresent).toBe(true);

	const listing = await folder.files.list();
	for (const file of listing.data!.files)
		expect(
			await readFile(join(root, file.path), 'utf8').catch(() => ''),
		).not.toContain('secret-key');
	expect((await folder.git.status()).data?.changes).toEqual([]);
	expect(
		await readFile(
			join(root, '.git', 'epicenter', 'whispering', 'device.json'),
			'utf8',
		),
	).toContain('secret-key');
});

test('a key from the environment decides, even an empty one, and cannot be changed from the app', async () => {
	const stub = endpoint();
	const { root, bridge } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: '' },
		fetch: stub.fetch,
	});
	// A key saved by an earlier launch that had no override.
	await mkdir(join(root, '.git', 'epicenter', 'whispering'), {
		recursive: true,
	});
	const saved = `${JSON.stringify({ transcriptionApiKey: 'saved-device-key' })}\n`;
	const deviceFile = join(
		root,
		'.git',
		'epicenter',
		'whispering',
		'device.json',
	);
	await writeFile(deviceFile, saved);
	await writeFile(join(root, 'take.wav'), toneWav());

	const info = await bridge.app<{
		credentialPresent: boolean;
		credentialFromEnvironment: boolean;
	}>('info');
	expect(info).toMatchObject({
		credentialPresent: false,
		credentialFromEnvironment: true,
	});
	await expect(bridge.app('credential', { key: 'typed-key' })).rejects.toThrow(
		'cannot be changed here',
	);
	expect(await readFile(deviceFile, 'utf8')).toBe(saved);

	// The empty override is what is used: the saved key is not sent.
	await bridge.app<Transcribed>('transcribe', transcribeRequest('take.wav'));
	expect(stub.requests).toHaveLength(1);
	expect(stub.requests[0]!.authorization).toBeNull();
});

test('the page is served without the token, may reach the shell’s commands, and paths stay inside it', async () => {
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
	// Only the shell gives the page the token; the host never serves it.
	expect(await index.text()).not.toContain(TOKEN);
	// The folder is reached through the shell's commands, so the page may call them.
	expect(index.headers.get('content-security-policy')).toContain(
		"connect-src 'self' ipc: http://ipc.localhost;",
	);
	expect((await get(shell.host, '/recordings/anything')).status).toBe(200);
	// A deep link or a refresh on a page of the app gets the app, not a 404.
	for (const route of ['/recordings', '/transformations']) {
		const deep = await get(shell.host, route);
		expect(deep.status).toBe(200);
		expect(deep.headers.get('content-type')).toContain('text/html');
	}
	expect((await get(shell.host, '/_app/missing.js')).status).toBe(404);
	expect((await get(shell.host, '/%2e%2e/outside-secret.txt')).status).toBe(
		404,
	);
});
