/**
 * Tauri Folder Adapter Tests
 *
 * `openFolder` from the desktop entry turns the native folder owner's commands
 * into the same folder handle the browser opener returns. These tests script
 * the shell's replies to pin what the adapter itself decides: what an
 * unanswered command means, when a guarded save may look again, and what
 * closing does.
 *
 * Key behaviors:
 * - Outside the shell, opening is refused and nothing is invoked; a refusal
 *   inside the shell never opens browser storage
 * - A save's capture comes from the bytes that were sent, not from a read
 * - A batch is one `apply`, and its receipt comes from what was sent
 * - A lost reply to a save is `Unconfirmed` and is never sent again; a lost
 *   reply to a read is an ordinary failure
 * - An outcome the owner could not confirm stays `Unconfirmed` here
 * - A page built for another protocol version is refused at attach
 * - A commit replies with its outcome alone, and a push names no pass to join
 * - A caller that stops waiting during a commit starts no push afterward
 * - A terminal command's steps are the same commands any save sends: nothing
 *   holds the folder around them, and a rewrite names the sha256 it read
 * - Closing stops a terminal command's later steps and waits for the one
 *   already sent
 * - Snapshot events replace the snapshot in order; a stale one is dropped
 * - Closing detaches this window once and does not shut the folder down
 *
 * See also:
 * - `tauri-native.test.ts` for the same adapter against the real Rust owner
 */
import { afterEach, expect, mock, test } from 'bun:test';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { hashBytes } from './capture.js';
import { defineFolder, defineTable, field } from './contract.js';

type Call = { cmd: string; args: Record<string, unknown> };
type Reply = (call: Call) => unknown;

let inShell = true;
let calls: Call[] = [];
/** Replies by command. A function that throws an `Error` loses the reply. */
let replies: Record<string, Reply> = {};
let failedListener: string | undefined;
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();

const refuse = (error: unknown): never => {
	// A Rust `Err` rejects with the error value itself, not an `Error`.
	throw error;
};

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(cmd: string, args: Record<string, unknown> = {}) {
		const name = cmd.replace('plugin:epicenter-folder|', '');
		calls.push({ cmd: name, args });
		const reply = replies[name];
		if (reply === undefined) throw new Error(`no scripted reply for ${name}`);
		return reply({ cmd: name, args });
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	async listen(name: string, callback: (event: { payload: unknown }) => void) {
		if (failedListener !== undefined && name.endsWith(failedListener))
			throw new Error('event.listen not allowed');
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return () => set.delete(callback);
	},
}));

const { openFolder } = await import('./tauri.js');

const definition = defineFolder({
	id: 'so.epicenter.taurifoldertest',
	kv: {},
	tables: {
		todos: defineTable({
			fields: { title: field.string(), done: field.boolean() },
		}),
	},
});

const wireSnapshot = (overrides: Record<string, unknown> = {}) => ({
	branch: 'main',
	remote: null,
	commitOnEdit: true,
	files: { state: 'unknown', error: null },
	sync: { state: 'unknown', error: null },
	activity: Object.fromEntries(
		['scan', 'commit', 'push', 'fetch', 'pull'].map((name) => [
			name,
			{ active: false },
		]),
	),
	lastCommit: null,
	lastPush: null,
	lastFetch: null,
	lastPull: null,
	closed: false,
	...overrides,
});

function emit(name: string, payload: unknown) {
	for (const listener of listeners.get(`plugin:epicenter-folder:${name}`) ?? [])
		listener({ payload });
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);

/** Wait until the adapter has sent `count` of a command. */
async function untilSent(cmd: string, count = 1) {
	while (sent(cmd).length < count) await Bun.sleep(0);
}

/** The number the scripted owner gives the first request a test opens. */
const FIRST_REQUEST = 100;

async function attached() {
	let nextRequest = FIRST_REQUEST;
	replies = {
		attach: () => ({
			session: 7,
			root: '/Users/someone/Epicenter/notes',
			sequence: 3,
			snapshot: wireSnapshot(),
		}),
		detach: () => null,
		open_request: () => nextRequest++,
		withdraw_request: () => null,
	};
	const folder = expectOk(await openFolder({ id: 'notes', definition }));
	expect(sent('attach')[0]?.args).toEqual({ scope: 'notes', protocol: 3 });
	expect(folder.location).toEqual({
		kind: 'directory',
		root: '/Users/someone/Epicenter/notes',
	});
	calls = [];
	return folder;
}

afterEach(() => {
	inShell = true;
	calls = [];
	replies = {};
	failedListener = undefined;
	listeners.clear();
});

test("the folder opened is the definition's own ID unless another is named", async () => {
	replies = {
		attach: () => ({
			session: 7,
			root: '/Users/someone/Epicenter/notes',
			sequence: 3,
			snapshot: wireSnapshot({ commitOnEdit: false }),
		}),
		detach: () => null,
	};
	const folder = expectOk(
		await openFolder({
			definition,
			// Browser settings do not reach the shell: its own policy is in effect.
			browser: { commitOnEdit: true },
		}),
	);
	expect(sent('attach')[0]?.args).toEqual({
		scope: 'so.epicenter.taurifoldertest',
		protocol: 3,
	});
	expect(folder.git.snapshot.commitOnEdit).toBe(false);
	await folder.close();
});

test('a refusal inside the shell is returned; browser storage is never opened instead', async () => {
	const indexedDB = new IDBFactory();
	for (const refusal of [
		{ name: 'UnknownScope', scope: 'notes' },
		{ name: 'WindowNotPermitted', scope: 'notes', window: 'main' },
		'plugin epicenter-folder not found',
	]) {
		replies = { attach: () => refuse(refusal) };
		const refused = expectErr(
			await openFolder({
				id: 'notes',
				definition,
				browser: { indexedDb: { indexedDB, IDBKeyRange } },
			}),
		);
		expect<string>(refused.name).toBe(
			typeof refusal === 'string' ? 'Unavailable' : refusal.name,
		);
	}
	expect(await indexedDB.databases()).toEqual([]);
});

test('outside the desktop shell, opening is refused and nothing is invoked', async () => {
	inShell = false;

	const refused = expectErr(await openFolder({ id: 'notes', definition }));

	expect(refused.name).toBe('NotTauri');
	expect(calls).toEqual([]);
});

test('an attach the shell refuses is returned with its reason and leaves no listener', async () => {
	replies = {
		attach: () =>
			refuse({ name: 'Busy', root: '/Users/someone/Epicenter/notes' }),
	};

	const refused = expectErr(await openFolder({ id: 'notes', definition }));

	expect(refused.name).toBe('Busy');
	expect(refused.message).toContain('/Users/someone/Epicenter/notes');
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('a bare-string attach rejection preserves its cause and leaves no listeners', async () => {
	const reason = 'epicenter-folder.attach not allowed';
	replies.attach = () => refuse(reason);
	const error = expectErr(await openFolder({ id: 'notes', definition }));
	expect(error.name).toBe('Unavailable');
	expect(error.message).toContain(reason);
	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test.each([
	'folder-snapshot-changed',
	'folder-files-changed',
])('a failed %s listener leaves no listener and never attaches', async (event) => {
	failedListener = event;
	const error = expectErr(await openFolder({ id: 'notes', definition }));
	expect(error.name).toBe('Unavailable');
	expect(error.message).toContain('event.listen not allowed');
	expect(calls).toEqual([]);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test('a desktop app that speaks another protocol is refused at attach, before any other call', async () => {
	calls = [];
	replies = {
		attach: () => refuse({ name: 'Incompatible', host: 4, page: 3 }),
	};
	const refused = expectErr(await openFolder({ id: 'notes', definition }));
	expect(refused).toMatchObject({ name: 'Incompatible', host: 4, page: 3 });
	expect(refused.message).toContain('Update the app');
	expect(calls).toEqual([
		{ cmd: 'attach', args: { scope: 'notes', protocol: 3 } },
	]);
});

test('a save whose reply is lost is Unconfirmed and is sent exactly once', async () => {
	const folder = await attached();
	replies.apply = () => {
		throw new Error('the webview lost its IPC connection');
	};

	const lost = expectErr(await folder.files.create('notes/a.md', 'text'));

	expect(lost.name).toBe('Unconfirmed');
	expect(lost.message).toContain('may have completed');
	expect(sent('apply')).toHaveLength(1);
	expect(sent('apply')[0]?.args).toEqual({
		session: 7,
		changes: [
			{ kind: 'create', path: 'notes/a.md', bytes: [116, 101, 120, 116] },
		],
	});
});

test('a read whose reply is lost is an ordinary failure, and Git changes are Unconfirmed', async () => {
	const folder = await attached();
	const lose = () => {
		throw new Error('connection lost');
	};
	replies = {
		...replies,
		read: lose,
		commit: lose,
		push: lose,
		stage: lose,
		status: lose,
	};

	expect(expectErr(await folder.files.read('a.md')).name).toBe('Io');
	expect(expectErr(await folder.git.status()).name).toBe('Failed');
	expect(await folder.git.commit()).toEqual({
		status: 'unconfirmed',
		error: 'connection lost',
	});
	expect(await folder.git.push()).toEqual({
		status: 'unconfirmed',
		error: 'connection lost',
	});
	expect(expectErr(await folder.git.stage('all')).name).toBe('Unconfirmed');
	for (const cmd of ['read', 'commit', 'push', 'stage', 'status'])
		expect(sent(cmd)).toHaveLength(1);
});

test('a primitive rejection of a change remains Unconfirmed and is not retried', async () => {
	const folder = await attached();
	const reason = 'epicenter-folder.apply not allowed';
	replies.apply = () => refuse(reason);
	const error = expectErr(await folder.files.create('a.md', 'new'));
	expect(error.name).toBe('Unconfirmed');
	expect(error.message).toContain(reason);
	expect(sent('apply')).toHaveLength(1);
	await folder.close();
});

test('typed refusals from the owner become the shared file errors', async () => {
	const folder = await attached();
	const sha256 = 'a'.repeat(64);
	replies.apply = () =>
		refuse({
			name: 'Refused',
			error: {
				name: 'Conflict',
				path: 'a.md',
				expectedSha256: sha256,
				actualSha256: null,
			},
		});

	const conflict = expectErr(
		await folder.files.replace({ path: 'a.md', sha256 }, 'next'),
	);

	expect(conflict.name).toBe('Conflict');
	if (conflict.name !== 'Conflict') return;
	expect(conflict.expectedSha256).toEqual(sha256);
	expect(conflict.actualSha256).toBeUndefined();
	expect(conflict.message).toBe(
		"No file exists at 'a.md' to match the captured SHA-256",
	);

	replies.apply = () =>
		refuse({
			name: 'Partial',
			applied: [{ kind: 'write', path: 'b.md' }],
			failed: { kind: 'remove', path: 'a.md' },
			error: { name: 'Io', path: 'a.md', operation: 'retire', cause: 'busy' },
			notAttempted: [],
		});
	const partial = expectErr(
		await folder.files.move({ path: 'a.md', sha256 }, 'b.md'),
	);
	expect(partial.name).toBe('Partial');
	if (partial.name !== 'Partial') return;
	expect(partial.applied).toEqual([{ kind: 'write', path: 'b.md' }]);
	expect(partial.error.message).toBe("Could not retire 'a.md': busy");
});

test('an outcome the owner itself could not confirm is Unconfirmed, not a refusal', async () => {
	const folder = await attached();
	const unknown = {
		name: 'Unconfirmed',
		path: 'a.md',
		operation: 'publishing to',
		cause: 'the worker stopped',
	};
	replies.apply = () => refuse(unknown);
	replies.commit = () => ({
		status: 'unconfirmed',
		error: 'the worker stopped',
	});
	replies.fetch = () =>
		refuse({
			name: 'Unconfirmed',
			operation: 'fetch',
			cause: 'the worker stopped',
		});

	const save = expectErr(await folder.files.overwrite('a.md', 'text'));

	expect(save.name).toBe('Unconfirmed');
	expect(save.message).toContain('may have completed');
	expect(await folder.git.commit()).toEqual({
		status: 'unconfirmed',
		error: 'the worker stopped',
	});
	expect(expectErr(await folder.git.fetch()).name).toBe('Unconfirmed');
	expect(sent('apply')).toHaveLength(1);
});

test("a table save changes exactly its row file, under that file's exact condition", async () => {
	const folder = await attached();
	// Audio already shares the stem. It is not asked about and not sent.
	replies.children = () => ({ files: ['take.png'], directories: [] });
	replies.apply = () => null;

	const created = expectOk(
		await folder.tables.todos.create({
			stem: 'take',
			fields: { title: 'Take', done: false },
		}),
	);

	expect(sent('apply')).toHaveLength(1);
	const { changes, ...rest } = sent('apply')[0]?.args as {
		changes: { kind: string; path: string; expectedSha256?: string }[];
	};
	expect(rest).toEqual({ session: 7 });
	expect(changes.map(({ kind, path }) => ({ kind, path }))).toEqual([
		{ kind: 'create', path: 'todos/take.md' },
	]);

	calls = [];
	expectOk(await folder.tables.todos.rename(created, 'next'));
	expectOk(await folder.tables.todos.delete(created));
	expect(sent('apply').map((call) => call.args.changes)).toEqual([
		[
			{
				kind: 'move',
				from: 'todos/take.md',
				to: 'todos/next.md',
				expectedSha256: created.sha256,
			},
		],
		[{ kind: 'remove', path: 'todos/take.md', expectedSha256: created.sha256 }],
	]);
});

test('a save returns the capture of the bytes it sent, without reading them back', async () => {
	const folder = await attached();
	replies.apply = () => null;
	const sentVersion = await hashBytes(new TextEncoder().encode('mine'));

	const created = expectOk(await folder.files.create('a.md', 'mine'));
	const moved = expectOk(await folder.files.move(created, 'b.md'));

	// The owner was asked to publish and nothing else: no read followed.
	expect(calls.map((call) => call.cmd)).toEqual(['apply', 'apply']);
	expect(created).toEqual({ path: 'a.md', sha256: sentVersion });
	expect(moved).toEqual({ path: 'b.md', sha256: sentVersion });

	// Another writer replaced the file right after the save was acknowledged.
	// Reading is a new observation; the save's capture is still what was saved.
	const raced = new TextEncoder().encode('someone else');
	replies.read = () => ({
		bytes: [...raced],
		sha256: 'e'.repeat(64),
	});
	const observed = expectOk(await folder.files.read('b.md'));
	expect(observed.sha256).toEqual('e'.repeat(64));
	expect(moved.sha256).toEqual(sentVersion);
	expect(Object.isFrozen(moved)).toBe(true);
});

const ROW_SOURCE = '---\ntitle: Take\ndone: false\n---\n';

test('a batch is one apply: ordered changes, exact conditions, and a receipt from what was sent', async () => {
	const folder = await attached();
	// Audio shares the row's stem; only a colliding row name would matter.
	replies.children = () => ({
		files: ['take.png', 'other.md'],
		directories: [],
	});
	replies.apply = () => null;
	const audio = new Uint8Array([1, 2, 3]);
	const observed = {
		path: 'audio/old.webm',
		sha256: 'a'.repeat(64),
	};

	const moving = { path: 'audio/move.webm', sha256: 'b'.repeat(64) };

	const receipt = expectOk(
		await folder.batch((batch) => {
			batch.files.replace(observed, audio);
			batch.tables.todos.create({
				stem: 'take',
				fields: { title: 'Take', done: false },
			});
			batch.files.move(moving, 'audio/kept.webm');
		}),
	);

	// One admission published once. Before it, the typed row's directory was
	// listed by name for the destination check; no file was read, before or
	// after.
	expect(calls.map((call) => call.cmd)).toEqual(['children', 'apply']);
	expect(sent('children')[0]?.args).toEqual({ session: 7, directory: 'todos' });
	const { changes, ...rest } = sent('apply')[0]?.args as {
		changes: Record<string, unknown>[];
	};
	expect(rest).toEqual({ session: 7 });
	expect(changes).toEqual([
		{
			kind: 'replace',
			path: 'audio/old.webm',
			bytes: [1, 2, 3],
			expectedSha256: observed.sha256,
		},
		{
			kind: 'create',
			path: 'todos/take.md',
			bytes: [...new TextEncoder().encode(ROW_SOURCE)],
		},
		{
			kind: 'move',
			from: moving.path,
			to: 'audio/kept.webm',
			expectedSha256: moving.sha256,
		},
	]);
	expect(receipt.steps).toEqual([
		{
			kind: 'write',
			path: 'audio/old.webm',
			file: { path: 'audio/old.webm', sha256: await hashBytes(audio) },
		},
		{
			kind: 'write',
			path: 'todos/take.md',
			file: {
				path: 'todos/take.md',
				sha256: await hashBytes(new TextEncoder().encode(ROW_SOURCE)),
			},
		},
		{
			kind: 'move',
			from: moving.path,
			to: 'audio/kept.webm',
			file: { path: 'audio/kept.webm', sha256: moving.sha256 },
		},
	]);
});

test('a batch the owner stopped partway keeps its applied steps, and a lost reply fabricates no receipt', async () => {
	const folder = await attached();
	replies.children = () => ({ files: [], directories: [] });
	const publish = () =>
		folder.batch((batch) => {
			batch.files.create('audio/take.webm', new Uint8Array([1]));
			batch.tables.todos.create({
				stem: 'take',
				fields: { title: 'Take', done: false },
			});
		});
	replies.apply = () =>
		refuse({
			name: 'Partial',
			applied: [{ kind: 'write', path: 'audio/take.webm' }],
			failed: { kind: 'write', path: 'todos/take.md' },
			error: {
				name: 'Io',
				path: 'todos/take.md',
				operation: 'create',
				cause: 'disk full',
			},
			notAttempted: [],
		});
	const partial = expectErr(await publish());
	expect(partial).toMatchObject({
		name: 'Partial',
		applied: [{ kind: 'write', path: 'audio/take.webm' }],
		failed: { kind: 'write', path: 'todos/take.md' },
	});

	calls = [];
	replies.apply = () => {
		throw new Error('the webview lost its IPC connection');
	};
	const lost = await publish();
	expect(lost.data).toBeNull();
	expect(lost.error?.name).toBe('Unconfirmed');
	// Sent once; nothing here decides to send it again.
	expect(sent('apply')).toHaveLength(1);
});

/**
 * How a terminal command failed. A file step the folder refused ends the
 * command, either as a failed result or as the folder's own error thrown
 * out of a redirection; both say the same thing to a person.
 */
const failure = (running: Promise<{ exitCode: number; stderr: string }>) =>
	running.then(
		(result) => {
			expect(result.exitCode).not.toBe(0);
			return result.stderr;
		},
		(error: Error) => error.message,
	);

test("a terminal command's steps are the commands any save sends, and nothing holds the folder around them", async () => {
	const folder = await attached();
	const original = new TextEncoder().encode('first\n');
	const sha256 = await hashBytes(original);
	replies.list = () => ({
		files: [{ path: 'note.md', size: original.byteLength }],
		directories: [],
	});
	replies.read = () => ({ bytes: [...original], sha256 });
	replies.apply = () => null;
	const terminal = folder.terminal();

	// A redirection overwrites; an append rewrites what the command read.
	const result = await terminal.exec(
		'echo fresh > other.md && echo second >> note.md',
	);

	expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
	// Listings, a read, and two saves: no command acquires or releases
	// anything, before, between, or after them.
	expect([...new Set(calls.map((call) => call.cmd))].sort()).toEqual([
		'apply',
		'list',
		'read',
	]);
	const applied = sent('apply').flatMap((call) => {
		const { changes, ...rest } = call.args as {
			changes: { kind: string; path: string; expectedSha256?: string }[];
		};
		// The same arguments a page's own save sends.
		expect(rest).toEqual({ session: 7 });
		return changes;
	});
	const firstTo = (path: string) =>
		applied.find((change) => change.path === path)?.expectedSha256;
	expect(applied.find((change) => change.path === 'other.md')?.kind).toBe(
		'overwrite',
	);
	// The owner refuses this if another writer replaced the file since.
	expect(firstTo('note.md')).toEqual(sha256);

	// The owner's refusal of that rewrite reaches the command as a failure.
	calls = [];
	replies.apply = () =>
		refuse({
			name: 'Refused',
			error: {
				name: 'Conflict',
				path: 'note.md',
				expectedSha256: sha256,
				actualSha256: 'e'.repeat(64),
			},
		});
	const stale = await failure(
		terminal.exec('echo third >> note.md && echo x > c.md'),
	);
	expect(stale).toContain(
		"The file at 'note.md' does not match the captured SHA-256",
	);
	// The step after the refused one never ran.
	expect(sent('apply')).toHaveLength(1);
});

test('a terminal command whose listing is lost fails and sends nothing else', async () => {
	const folder = await attached();
	replies.list = () => {
		throw new Error('connection lost');
	};

	const failed = await failure(
		folder.terminal({ cwd: '/' }).exec('echo x > a.md'),
	);

	expect(failed).toContain('connection lost');
	expect(calls.map((call) => call.cmd)).toEqual(['list']);
});

test('snapshot events replace the snapshot in order and a stale one is dropped', async () => {
	const folder = await attached();
	const heard: (string | undefined)[] = [];
	folder.git.subscribe((snapshot) => heard.push(snapshot.lastCommit?.status));
	const committed = (sequence: number, oid: string) =>
		emit('folder-snapshot-changed', {
			scope: 'notes',
			sequence,
			snapshot: wireSnapshot({
				lastCommit: {
					at: 1,
					result: {
						status: 'committed',
						oid,
						parent: null,
						message: 'Add a.md',
						changedPaths: 1,
						indexWarning: null,
					},
				},
			}),
		});

	committed(3, 'stale: the attach reply already carried sequence 3');
	committed(5, 'five');
	committed(4, 'late');
	emit('folder-snapshot-changed', {
		scope: 'another-scope',
		sequence: 9,
		snapshot: wireSnapshot(),
	});

	expect(heard).toEqual([undefined, 'committed']);
	expect(folder.git.snapshot.lastCommit).toEqual({
		status: 'committed',
		oid: 'five',
		parent: undefined,
		message: 'Add a.md',
		changedPaths: 1,
		indexWarning: undefined,
		at: 1,
	});
	expect(folder.git.snapshot.remote).toBeUndefined();
});

test('file change events reach listeners until they stop listening', async () => {
	const folder = await attached();
	const heard: (readonly string[])[] = [];
	const stop = folder.onFilesChanged((paths) => heard.push(paths));

	emit('folder-files-changed', {
		scope: 'notes',
		revision: 1,
		paths: ['a.md'],
	});
	emit('folder-files-changed', {
		scope: 'other',
		revision: 2,
		paths: ['b.md'],
	});
	stop();
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 3,
		paths: ['c.md'],
	});

	expect(heard).toEqual([['a.md']]);
});

test('an observer that throws on an owner event silences no other observer, and closing from one fences the rest', async () => {
	const folder = await attached();
	const files: string[] = [];
	const branches: string[] = [];
	folder.onFilesChanged(() => {
		throw new Error('broken listener');
	});
	folder.onFilesChanged((paths) => files.push(...paths));
	let throwing = false;
	folder.git.subscribe(() => {
		if (throwing) throw new Error('broken subscriber');
	});
	folder.git.subscribe((snapshot) => branches.push(snapshot.branch));
	throwing = true;

	emit('folder-files-changed', {
		scope: 'notes',
		revision: 1,
		paths: ['a.md'],
	});
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({ branch: 'next' }),
	});
	expect(files).toEqual(['a.md']);
	expect(branches).toEqual(['main', 'next']);
	// The adapter's own state moved on as well: the throw cost it nothing.
	expect(folder.git.snapshot.branch).toBe('next');

	// A listener that closes the folder: the one after it is not called, in
	// this dispatch or any later one.
	let closing: Promise<void> | undefined;
	folder.onFilesChanged(() => {
		closing = folder.close();
	});
	const late: string[] = [];
	folder.onFilesChanged((paths) => late.push(...paths));
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 2,
		paths: ['b.md'],
	});
	await closing;
	emit('folder-files-changed', {
		scope: 'notes',
		revision: 3,
		paths: ['c.md'],
	});
	expect(files).toEqual(['a.md', 'b.md']);
	expect(late).toEqual([]);
	expect(sent('detach')).toHaveLength(1);
});

/** A reply the test settles later, to hold a command in flight. */
function held<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { reply: () => promise, settle: resolve };
}

/** The commit command's reply: the settled outcome itself. */
const committed = {
	status: 'committed',
	oid: 'c'.repeat(40),
	parent: null,
	message: 'Add a.md',
	changedPaths: 1,
	indexWarning: null,
};

test('a merge is unsupported in the desktop app: nothing is sent and the snapshot shows no merge', async () => {
	const folder = await attached();
	expect(folder.git.mergeUnsupported).toBeString();
	expect(expectErr(await folder.git.mergeIncoming())).toMatchObject({
		name: 'Unsupported',
		reason: folder.git.mergeUnsupported,
	});
	expect(calls).toEqual([]);
	expect(folder.git.snapshot.activity.merge).toEqual({ active: false });
	expect(folder.git.snapshot.lastMerge).toBeUndefined();
	await folder.close();
});

test('closing waits for a Git call already running, then detaches, and later Git calls invoke nothing', async () => {
	const folder = await attached();
	const commit = held<typeof committed>();
	replies.commit = commit.reply;

	const committing = folder.git.commit();
	const closing = folder.close();
	await Bun.sleep(20);
	// The session is still attached: the commit's reply has somewhere to land.
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);
	commit.settle(committed);

	expect((await committing).status).toBe('committed');
	await closing;
	expect(calls.map((call) => call.cmd)).toEqual(['commit', 'detach']);

	calls = [];
	expect(await folder.git.commit()).toEqual({ status: 'closed' });
	expect(await folder.git.push()).toEqual({ status: 'closed' });
	expect(await folder.git.commitAndPush()).toEqual({
		commit: { status: 'closed' },
		push: { status: 'closed' },
	});
	for (const refused of [
		await folder.git.status(),
		await folder.git.fetch(),
		await folder.git.pullFastForward(),
		await folder.git.mergeIncoming(),
		await folder.git.paths(),
		await folder.git.stage('all'),
		await folder.git.commitStaged('message'),
		await folder.git.diff({ staged: false, paths: [] }),
		await folder.git.log(1),
	])
		expect(expectErr(refused).name).toBe('Closed');
	const terminal = await folder.terminal().exec('ls');
	expect(terminal).toEqual({
		stdout: '',
		stderr: 'The folder is closed\n',
		exitCode: 1,
	});
	expect(calls).toEqual([]);
});

test('closing stops this page waiting for a push and a fetch and withdraws both requests before detaching', async () => {
	const folder = await attached();
	const push = held<{ status: string; oid: string }>();
	replies.push = push.reply;
	const fetch = held<{ oid: null }>();
	replies.fetch = fetch.reply;

	const pushing = folder.git.push();
	const fetching = folder.git.fetch();
	await untilSent('push');
	await untilSent('fetch');
	await folder.close();

	expect(await pushing).toEqual({ status: 'stoppedWaiting' });
	expect(expectErr(await fetching).name).toBe('StoppedWaiting');
	// Each command named a request the owner already knew, and closing
	// withdrew each one while the session still existed. What the owner had
	// not started, it will not start; the page does not learn which.
	expect(calls.map((call) => call.cmd)).toEqual([
		'open_request',
		'open_request',
		'push',
		'fetch',
		'withdraw_request',
		'withdraw_request',
		'detach',
	]);
	const requests = [FIRST_REQUEST, FIRST_REQUEST + 1];
	expect(
		[...sent('push'), ...sent('fetch')].map((call) => call.args.request).sort(),
	).toEqual(requests);
	expect(
		sent('withdraw_request')
			.map((call) => call.args)
			.sort((a, b) => Number(a.request) - Number(b.request)),
	).toEqual(requests.map((request) => ({ session: 7, request })));
	push.settle({ status: 'pushed', oid: 'c'.repeat(40) });
	fetch.settle({ oid: null });
});

test('closing detaches while a terminal save is awaiting its reply, and its later steps send nothing', async () => {
	const folder = await attached();
	replies.list = () => ({ files: [], directories: [] });
	const saving = held<null>();
	replies.apply = saving.reply;
	const terminal = folder.terminal();

	const running = failure(terminal.exec('echo one > a.md && echo two > b.md'));
	const queued = terminal.exec('echo three > c.md');
	await untilSent('apply');
	const closing = folder.close();
	await Bun.sleep(20);
	// The sent apply owns its outcome; detaching does not wait for its reply.
	expect(sent('detach')).toHaveLength(1);
	saving.settle(null);
	await closing;

	// The save that was sent landed; nothing of the command followed it.
	expect(await running).toContain('The folder is closed');
	expect(sent('apply')).toHaveLength(1);
	expect(
		(sent('apply')[0]?.args.changes as { path: string }[]).map(
			(change) => change.path,
		),
	).toEqual(['a.md']);
	expect(calls.at(-1)?.cmd).toBe('detach');
	expect(sent('detach')).toHaveLength(1);
	// The command queued behind it never started.
	expect(await queued).toEqual({
		stdout: '',
		stderr: 'EIO: The folder is closed\n',
		exitCode: 1,
	});
});

test('a commit whose outcome is unknown leaves the push unknown, not skipped', async () => {
	const folder = await attached();
	replies.commit = () => {
		throw new Error('connection lost');
	};

	expect(await folder.git.commitAndPush()).toEqual({
		commit: { status: 'unconfirmed', error: 'connection lost' },
		push: { status: 'unconfirmed', error: 'connection lost' },
	});

	// A commit that may not have happened is no reason to push.
	expect(sent('push')).toHaveLength(0);
});

test('a caller that stops waiting during a commit starts no push, even after the commit lands', async () => {
	const folder = await attached();
	// A remote exists, so a commit that completes is normally followed by a push.
	emit('folder-snapshot-changed', {
		scope: 'notes',
		sequence: 4,
		snapshot: wireSnapshot({
			remote: { url: 'https://example.com/notes.git', branch: 'main' },
		}),
	});
	replies.push = () => ({ status: 'pushed', oid: committed.oid });
	replies.commit = () => committed;
	expect(await folder.git.commitAndPush()).toEqual({
		commit: {
			status: 'committed',
			oid: committed.oid,
			parent: undefined,
			message: 'Add a.md',
			changedPaths: 1,
			indexWarning: undefined,
		},
		push: { status: 'pushed', oid: committed.oid },
	});
	// The explicit push names the request this session opened for it.
	expect(calls.map((call) => call.cmd)).toEqual([
		'commit',
		'open_request',
		'push',
	]);
	expect(sent('push')[0]?.args).toEqual({
		session: 7,
		request: FIRST_REQUEST,
	});
	// It had its answer, so there was nothing to withdraw.
	expect(sent('withdraw_request')).toEqual([]);

	calls = [];
	const commit = held<typeof committed>();
	replies.commit = commit.reply;
	const waiting = new AbortController();
	const stopped = folder.git.commitAndPush({ signal: waiting.signal });
	waiting.abort();
	expect(await stopped).toEqual({
		commit: { status: 'stoppedWaiting' },
		push: { status: 'stoppedWaiting' },
	});
	// The commit the caller left lands afterward. Nothing pushes it.
	commit.settle(committed);
	await Bun.sleep(0);
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);

	// A caller that had already stopped when it asked still sends the commit
	// it asked for, and nothing after it.
	calls = [];
	replies.commit = () => committed;
	const already = AbortSignal.abort();
	expect(await folder.git.commitAndPush({ signal: already })).toEqual({
		commit: { status: 'stoppedWaiting' },
		push: { status: 'stoppedWaiting' },
	});
	await Bun.sleep(0);
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);
});

test('a caller that leaves a push or fetch asks for nothing, or withdraws exactly the request it opened', async () => {
	const folder = await attached();
	const push = held<{ status: string; oid: string | null }>();
	replies.push = push.reply;
	const fetch = held<{ oid: null }>();
	replies.fetch = fetch.reply;

	// Left before asking: no command reaches the owner at all.
	const gone = AbortSignal.abort();
	expect(await folder.git.push({ signal: gone })).toEqual({
		status: 'stoppedWaiting',
	});
	expect(expectErr(await folder.git.fetch({ signal: gone })).name).toBe(
		'StoppedWaiting',
	);
	expect(calls).toEqual([]);

	// Left while the request was being opened: it is withdrawn the moment its
	// number is known, and the push that would have named it is never sent.
	const opening = held<number>();
	const open = replies.open_request;
	if (open === undefined) throw new Error('the request opener is configured');
	replies.open_request = opening.reply;
	const early = new AbortController();
	const never = folder.git.push({ signal: early.signal });
	early.abort();
	expect(await never).toEqual({ status: 'stoppedWaiting' });
	opening.settle(41);
	await untilSent('withdraw_request');
	expect(calls).toEqual([
		{ cmd: 'open_request', args: { session: 7 } },
		{ cmd: 'withdraw_request', args: { session: 7, request: 41 } },
	]);

	// Left after the commands were sent: each caller stops waiting, and each
	// request is withdrawn once. The replies are still outstanding, so the
	// page is told only that it stopped waiting.
	calls = [];
	replies.open_request = open;
	const waiting = new AbortController();
	const pushing = folder.git.push({ signal: waiting.signal });
	const fetching = folder.git.fetch({ signal: waiting.signal });
	await untilSent('push');
	await untilSent('fetch');
	const requests = [FIRST_REQUEST, FIRST_REQUEST + 1];
	expect(
		[sent('push')[0]?.args.request, sent('fetch')[0]?.args.request].sort(),
	).toEqual(requests);
	waiting.abort();
	expect(await pushing).toEqual({ status: 'stoppedWaiting' });
	expect(expectErr(await fetching).name).toBe('StoppedWaiting');
	expect(
		sent('withdraw_request')
			.map((call) => call.args.request)
			.sort(),
	).toEqual(requests);

	// The owner's late replies change nothing, and are not withdrawn again.
	push.settle({ status: 'cancelled', oid: null });
	fetch.settle({ oid: null });
	await Bun.sleep(0);
	expect(sent('withdraw_request')).toHaveLength(2);
	await folder.close();
	expect(sent('withdraw_request')).toHaveLength(2);
});

test('an unacknowledged push or fetch releases its opened request without retrying', async () => {
	const folder = await attached();
	replies.push = () => refuse('push not allowed');
	replies.fetch = () => {
		throw new Error('fetch reply lost');
	};

	expect(await folder.git.push()).toEqual({
		status: 'unconfirmed',
		error: 'push not allowed',
	});
	expect(expectErr(await folder.git.fetch()).name).toBe('Unconfirmed');
	expect(sent('withdraw_request').map((call) => call.args)).toEqual([
		{ session: 7, request: FIRST_REQUEST },
		{ session: 7, request: FIRST_REQUEST + 1 },
	]);
	expect(sent('push')).toHaveLength(1);
	expect(sent('fetch')).toHaveLength(1);
	await folder.close();
});

test('a fetch the owner never started for a withdrawn caller is reported as stopped waiting', async () => {
	const folder = await attached();
	replies.fetch = () => refuse({ name: 'Withdrawn' });
	replies.push = () => ({ status: 'cancelled', oid: null });

	expect(expectErr(await folder.git.fetch()).name).toBe('StoppedWaiting');
	expect(await folder.git.push()).toEqual({
		status: 'cancelled',
		oid: undefined,
	});
});

test('a push the owner refuses before pinning a commit names no commit', async () => {
	const folder = await attached();
	replies.push = () =>
		refuse({
			name: 'Denied',
			reason: 'this window has no such folder session',
		});

	const refused = await folder.git.push();

	expect(refused).toEqual({
		status: 'skipped',
		reason: 'Git push failed: this window has no such folder session',
	});
	replies.push = () => ({
		status: 'skipped',
		reason: 'git rev-parse: bad ref',
	});
	expect(await folder.git.push()).toEqual({
		status: 'skipped',
		reason: 'git rev-parse: bad ref',
	});
});

test('closing detaches this window once and later work is refused as closed', async () => {
	const folder = await attached();
	replies.read = () => ({
		bytes: [1],
		sha256: 'b'.repeat(64),
	});
	expectOk(await folder.files.read('a.md'));

	await Promise.all([folder.close(), folder.close()]);

	expect(sent('detach')).toEqual([{ cmd: 'detach', args: { session: 7 } }]);
	expect(folder.signal.aborted).toBe(true);
	expect(expectErr(await folder.files.read('a.md')).name).toBe('Closed');
	expect(sent('read')).toHaveLength(1);
	expect([...listeners.values()].every((set) => set.size === 0)).toBe(true);
});
