/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` adapter, with the shell's `invoke` and
 * events scripted. The scripted owner keeps files in memory and checks
 * versions the way the shell's owner does; it stands in for the reply shapes,
 * not for the owner's own guarantees.
 *
 * Key behaviors:
 * - Outside the shell, a refused window, an unregistered scope, and a missing
 *   plugin each fail the open with a reason, and leave no listener behind
 * - The page names the Capture scope and is told the directory
 * - A change event for this scope is a hint to reread; it carries no contents
 * - A shell that refuses the quit listener still opens the folder and states
 *   the problem; a lifetime that cannot be set up detaches the session
 * - Closing detaches this page once, and a sibling page keeps saving
 * - Through the collection: exact Markdown is sent, a stale save is refused
 *   and keeps the draft, a lost reply keeps the draft and is reconciled on
 *   retry, a hint never replaces a dirty draft, a failed commit is reported
 *   beside a saved file, and a closed folder is reported as stopped
 * - An import whose first save lost its reply writes nothing twice: the retry
 *   finds the identical file, finishes, and a further retry creates nothing
 *
 * See also:
 * - `packages/folder/src/tauri.test.ts` for what the adapter decides
 * - `packages/folder/src/tauri-native.test.ts` for the real Rust owner
 * - `shell-lifetime.test.ts` for the quit protocol
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { captureDefinition } from '@epicenter/capture';
import { readLegacyBundle, runLegacyImport } from '@epicenter/capture/legacy';
import fixture from '../../../fixtures/legacy-bundle.json';
import { QUIT_REQUESTED_EVENT, SERVICE_STOPPED_EVENT } from './shell-lifetime.js';

const ROOT = '/Users/someone/Epicenter/so.epicenter.capture';
const PLUGIN = 'plugin:epicenter-folder|';
const FILES_CHANGED = 'plugin:epicenter-folder:folder-files-changed';
const SNAPSHOT_CHANGED = 'plugin:epicenter-folder:folder-snapshot-changed';

type Call = { cmd: string; args: Record<string, unknown> };
type Version = { sha256: string; size: number };
type Expected =
	| { kind: 'absent' }
	| { kind: 'any' }
	| ({ kind: 'version' } & Version);
type Change =
	| { kind: 'write'; path: string; bytes: number[]; expected: Expected }
	| { kind: 'remove'; path: string; expected: Expected };

let inShell = true;
let calls: Call[] = [];
/** Replaces the owner's reply to one command. Throw an `Error` to lose the reply. */
let overrides: Record<string, (call: Call, reply: () => unknown) => unknown> =
	{};
/** Event names whose `listen` throws before returning a promise. */
let brokenListens = new Set<string>();
/** Event names the shell refuses to let this window hear. */
let refusedListens = new Set<string>();
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
const files = new Map<string, Uint8Array>();
const sessions = new Set<number>();
let nextSession = 1;

const versionOf = (bytes: Uint8Array): Version => ({
	sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),
	size: bytes.length,
});

const wireSnapshot = (overridden: Record<string, unknown> = {}) => ({
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
	...overridden,
});

/** A Rust `Err` rejects with the error value itself, not an `Error`. */
const refuse = (error: unknown): never => {
	throw error;
};

function matches(expected: Expected, current: Uint8Array | undefined) {
	if (expected.kind === 'any') return true;
	if (expected.kind === 'absent') return current === undefined;
	if (current === undefined) return false;
	const actual = versionOf(current);
	return actual.sha256 === expected.sha256 && actual.size === expected.size;
}

function own({ cmd, args }: Call): unknown {
	const read = (path: string) => {
		const bytes = files.get(path);
		if (bytes === undefined) return undefined;
		return { bytes: Array.from(bytes), version: versionOf(bytes) };
	};
	switch (cmd) {
		case 'attach': {
			const session = nextSession++;
			sessions.add(session);
			return { session, root: ROOT, sequence: 0, snapshot: wireSnapshot() };
		}
		case 'detach':
			sessions.delete(args.session as number);
			return null;
		case 'children': {
			const prefix = `${args.directory as string}/`;
			const names = [...files.keys()]
				.filter((path) => path.startsWith(prefix))
				.map((path) => path.slice(prefix.length));
			if (names.length === 0)
				return refuse({ name: 'NotFound', path: args.directory });
			return { files: names, directories: [] };
		}
		case 'read':
			return (
				read(args.path as string) ??
				refuse({ name: 'NotFound', path: args.path })
			);
		case 'read_many':
			return (args.paths as string[]).map((path) => {
				const found = read(path);
				return found === undefined
					? { status: 'err', error: { name: 'NotFound', path } }
					: { status: 'ok', value: found };
			});
		case 'apply': {
			const changes = args.changes as Change[];
			for (const change of changes) {
				const current = files.get(change.path);
				if (!matches(change.expected, current))
					return refuse({
						name: 'Refused',
						error: {
							name: 'Conflict',
							path: change.path,
							expected: change.expected,
							actual: current === undefined ? null : versionOf(current),
						},
					});
			}
			for (const change of changes) {
				if (change.kind === 'write')
					files.set(change.path, Uint8Array.from(change.bytes));
				else files.delete(change.path);
			}
			return null;
		}
		case 'commit':
			return { status: 'unchanged', head: null, indexWarning: null };
		default:
			throw new Error(`the scripted owner has no ${cmd}`);
	}
}

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(name: string, args: Record<string, unknown> = {}) {
		const call = { cmd: name.replace(PLUGIN, ''), args };
		calls.push(call);
		const override = overrides[call.cmd];
		return override ? override(call, () => own(call)) : own(call);
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen(name: string, callback: (event: { payload: unknown }) => void) {
		if (brokenListens.has(name)) throw new Error(`${name} cannot be heard`);
		if (refusedListens.has(name))
			return Promise.reject(new Error('event.listen not allowed'));
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return Promise.resolve(() => set.delete(callback));
	},
}));

const { openCaptureHost } = await import('./folder.epicenter-host.js');
const { createCaptures } = await import('../captures.svelte.ts');

function emit(name: string, payload?: unknown) {
	for (const listener of listeners.get(name) ?? []) listener({ payload });
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
const listening = () =>
	[...listeners.values()].reduce((count, set) => count + set.size, 0);
const text = (path: string) => new TextDecoder().decode(files.get(path));
const put = (path: string, source: string) =>
	files.set(path, new TextEncoder().encode(source));

const SAVED =
	'---\ncapturedAt: 2026-10-01T10:30:00+08:00\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n  nested line\n';
const PATH = 'captures/one.md';

async function opened() {
	const host = await openCaptureHost();
	const captures = createCaptures(host, { batchMs: 60_000 });
	await captures.refresh();
	return { host, captures };
}

afterEach(() => {
	inShell = true;
	calls = [];
	overrides = {};
	brokenListens = new Set();
	refusedListens = new Set();
	listeners.clear();
	files.clear();
	sessions.clear();
});

test('outside the desktop shell, opening fails with the reason and invokes nothing', async () => {
	inShell = false;

	await expect(openCaptureHost()).rejects.toThrow('desktop app');

	expect(calls).toEqual([]);
	expect(listening()).toBe(0);
});

test.each([
	[
		'a scope the shell did not register',
		() => refuse({ name: 'UnknownScope', scope: captureDefinition.id }),
		`no folder registered as '${captureDefinition.id}'`,
	],
	[
		'a window the scope does not allow',
		() =>
			refuse({
				name: 'WindowNotPermitted',
				scope: captureDefinition.id,
				window: 'capture',
			}),
		"The window 'capture' may not use the folder",
	],
	[
		'a folder another Epicenter holds',
		() => refuse({ name: 'Busy', root: ROOT }),
		ROOT,
	],
	[
		'an attach that never reaches the shell',
		() => {
			throw new Error('the webview lost its IPC connection');
		},
		'the webview lost its IPC connection',
	],
] as const)('%s fails the open with its reason and leaves no listener', async (_name, attach, reason) => {
	overrides.attach = attach;

	await expect(openCaptureHost()).rejects.toThrow(reason);

	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect(listening()).toBe(0);
});

test('a plugin the shell did not install fails the open instead of opening anything else', async () => {
	// Tauri rejects an unknown or unpermitted command with a bare string.
	overrides.attach = () => refuse('epicenter-folder.attach not allowed');

	const failure = await openCaptureHost().then(
		() => undefined,
		(error: unknown) => error,
	);

	// The adapter's own refusal, with what the shell said kept as its cause.
	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe(
		'The folder could not be opened: epicenter-folder.attach not allowed',
	);
	expect((failure as Error).cause).toMatchObject({
		name: 'Unavailable',
		cause: 'epicenter-folder.attach not allowed',
	});

	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect(listening()).toBe(0);
});

test('the page names the Capture scope and is told the directory', async () => {
	const host = await openCaptureHost();

	expect(sent('attach')[0]?.args).toEqual({
		scope: 'so.epicenter.capture',
		protocol: 2,
	});
	expect(host.location).toEqual({ kind: 'directory', root: ROOT });
	expect(host.quitProtectionProblem).toBeUndefined();
	expect(listeners.get(QUIT_REQUESTED_EVENT)?.size).toBe(1);
	expect(listeners.get(SERVICE_STOPPED_EVENT)?.size).toBe(1);
	await host.close();
});

test('a change event for this scope is a hint to reread, and only for this scope', async () => {
	const host = await openCaptureHost();
	const hints: unknown[][] = [];
	const stop = host.onExternalChange((...args: unknown[]) => hints.push(args));

	emit(FILES_CHANGED, { scope: 'so.epicenter.todos', revision: 1, paths: [PATH] });
	expect(hints).toEqual([]);
	emit(FILES_CHANGED, { scope: captureDefinition.id, revision: 2, paths: [PATH] });
	expect(hints).toEqual([[]]);

	stop();
	emit(FILES_CHANGED, { scope: captureDefinition.id, revision: 3, paths: [PATH] });
	expect(hints).toHaveLength(1);
	await host.close();
});

test('a shell that refuses the quit listener still opens the folder and states the problem', async () => {
	refusedListens.add(QUIT_REQUESTED_EVENT);

	const host = await openCaptureHost();

	expect(host.quitProtectionProblem).toContain('event.listen not allowed');
	put(PATH, SAVED);
	const listed = await host.folder.tables.captures.list();
	expect(listed.data?.entries.map((entry) => entry.path)).toEqual([PATH]);
	await host.close();
	expect(listening()).toBe(0);
});

test('a lifetime that cannot be set up detaches the session it attached', async () => {
	brokenListens.add(QUIT_REQUESTED_EVENT);

	await expect(openCaptureHost()).rejects.toThrow('cannot be heard');

	expect(calls.map((call) => call.cmd)).toEqual(['attach', 'detach']);
	expect(sessions.size).toBe(0);
	expect(listening()).toBe(0);
});

test('closing detaches this page once, and a sibling page keeps saving', async () => {
	const first = await openCaptureHost();
	const second = await openCaptureHost();
	const [mine, theirs] = [...sessions] as [number, number];
	calls = [];

	await first.close();
	await first.close();

	expect(calls).toEqual([{ cmd: 'detach', args: { session: mine } }]);
	expect([...sessions]).toEqual([theirs]);
	const saved = await second.folder.files.create(PATH, SAVED);
	expect(saved.error).toBeNull();
	expect(text(PATH)).toBe(SAVED);
	let hints = 0;
	second.onExternalChange(() => hints++);
	emit(FILES_CHANGED, { scope: captureDefinition.id, revision: 1, paths: [PATH] });
	expect(hints).toBe(1);
	await second.close();
	expect(listening()).toBe(0);
});

test('a save sends the exact Markdown, checked against the version this page read', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = captures.open('one');
	if (!draft) throw new Error('no draft');
	calls = [];

	draft.newThought = 'second';
	expect(draft.addThought()).toBe(true);
	await draft.save();

	const expected = `${SAVED}- second\n`;
	expect(text(PATH)).toBe(expected);
	expect(sent('apply')).toHaveLength(1);
	expect(sent('apply')[0]?.args.changes).toEqual([
		{
			kind: 'write',
			path: PATH,
			bytes: Array.from(new TextEncoder().encode(expected)),
			expected: { kind: 'version', ...versionOf(new TextEncoder().encode(SAVED)) },
		},
	]);
	expect(draft.saveState.kind).toBe('saved');
	captures.close();
	await host.close();
});

test('a stale save is refused, the file stays as the other writer left it, and the draft is kept', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = captures.open('one');
	if (!draft) throw new Error('no draft');
	const theirs = `${SAVED}- from another window\n`;
	put(PATH, theirs);

	draft.inputSource(`${SAVED}- mine\n`);
	await draft.save();

	expect(text(PATH)).toBe(theirs);
	expect(draft.saveState.kind).toBe('conflict');
	expect(draft.buffer).toBe(`${SAVED}- mine\n`);
	expect(captures.unsettled).toBe(1);
	captures.close();
	await host.close();
});

test('a save whose reply is lost keeps the draft, is sent once, and is reconciled on retry', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = captures.open('one');
	if (!draft) throw new Error('no draft');
	const mine = `${SAVED}- mine\n`;
	calls = [];
	overrides.apply = (_call, reply) => {
		reply();
		throw new Error('the webview lost its IPC connection');
	};

	draft.inputSource(mine);
	await draft.save();

	expect(draft.saveState.kind).toBe('failed');
	expect(draft.buffer).toBe(mine);
	expect(sent('apply')).toHaveLength(1);
	expect(captures.unsettled).toBe(1);

	// The retry is checked against the file as this page last read it, so the
	// write that did land comes back as a change to review, not a second write.
	delete overrides.apply;
	await draft.save();

	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(mine);
	expect(draft.saveState).toMatchObject({
		kind: 'conflict',
		current: { kind: 'present', entry: { source: mine } },
	});
	expect(draft.buffer).toBe(mine);
	captures.close();
	await host.close();
});

test('a hint rereads: a clean draft follows the file, a dirty one is kept and nothing is written', async () => {
	put(PATH, SAVED);
	put('captures/two.md', SAVED);
	const { host, captures } = await opened();
	host.onExternalChange(() => void captures.refresh());
	const clean = captures.open('one');
	const dirty = captures.open('two');
	if (!clean || !dirty) throw new Error('no draft');
	dirty.inputSource(`${SAVED}- typed here\n`);
	calls = [];

	const outside = `${SAVED}- from another program\n`;
	put(PATH, outside);
	put('captures/two.md', outside);
	emit(FILES_CHANGED, {
		scope: captureDefinition.id,
		revision: 1,
		paths: [PATH, 'captures/two.md'],
	});
	await captures.refresh();

	expect(clean.buffer).toBe(outside);
	expect(clean.saveState.kind).toBe('saved');
	expect(dirty.buffer).toBe(`${SAVED}- typed here\n`);
	expect(dirty.saveState.kind).toBe('conflict');
	expect(sent('apply')).toEqual([]);
	expect(text('captures/two.md')).toBe(outside);
	captures.close();
	await host.close();
});

test('a failed commit is reported beside a saved file, and retried without rewriting it', async () => {
	const { host, captures } = await opened();
	captures.newCapture = 'Saved before history';
	const created = await captures.create();
	if (!created.ok) throw new Error(created.message);
	const saved = text(`captures/${created.stem}.md`);

	emit(SNAPSHOT_CHANGED, {
		scope: captureDefinition.id,
		sequence: 1,
		snapshot: wireSnapshot({
			lastCommit: {
				at: 1,
				result: { status: 'failed', error: 'index.lock exists' },
			},
		}),
	});

	expect(captures.git.lastCommit).toMatchObject({
		status: 'failed',
		error: 'index.lock exists',
	});
	expect(captures.unsettled).toBe(0);
	expect(captures.folderStopped).toBe(false);
	calls = [];
	expect((await captures.commit()).status).toBe('unchanged');
	expect(calls.map((call) => call.cmd)).toEqual(['commit']);
	expect(text(`captures/${created.stem}.md`)).toBe(saved);
	captures.close();
	await host.close();
});

test('a folder its owner closed is reported as stopped; a stopped service is not', async () => {
	const { host, captures } = await opened();
	host.onServiceStopped(() => captures.markServiceStopped());

	emit(SERVICE_STOPPED_EVENT);
	expect(captures.serviceStopped).toBe(true);
	expect(captures.folderStopped).toBe(false);

	emit(SNAPSHOT_CHANGED, {
		scope: captureDefinition.id,
		sequence: 1,
		snapshot: wireSnapshot({ closed: true }),
	});
	expect(captures.folderStopped).toBe(true);

	overrides.apply = () => refuse({ name: 'Refused', error: { name: 'Closed' } });
	captures.newCapture = 'typed after the folder closed';
	const created = await captures.create();
	expect(created.ok).toBe(false);
	expect(captures.newCapture).toBe('typed after the folder closed');
	captures.close();
	await host.close();
});

test('an import whose first save lost its reply is finished by a retry, and repeats create nothing', async () => {
	const read = readLegacyBundle(fixture);
	if (!read.ok) throw new Error('the fixture is not a bundle');
	const { host, captures } = await opened();
	let lost = 0;
	overrides.apply = (_call, reply) => {
		reply();
		lost++;
		throw new Error('the webview lost its IPC connection');
	};

	// The export landed, but its reply did not: nothing is claimed.
	await expect(
		runLegacyImport(captures.importFiles, read.bundle),
	).rejects.toThrow('Nothing was imported');
	expect(lost).toBe(1);
	const exported = [...files.keys()].filter((path) =>
		path.startsWith('recovery/legacy-export-'),
	);
	expect(exported).toHaveLength(1);
	const original = text(exported[0] as string);

	delete overrides.apply;
	const retry = await runLegacyImport(captures.importFiles, read.bundle);
	expect(retry.complete).toBe(true);
	expect(retry.documents.map((document) => document.status)).toEqual(
		Array.from({ length: 6 }, () => 'created'),
	);
	expect(retry.receipt.status).toBe('written');
	expect(text(exported[0] as string)).toBe(original);

	calls = [];
	const again = await runLegacyImport(captures.importFiles, read.bundle);
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toHaveLength(6);
	// The export and the report are found identical; nothing is replaced.
	expect(text(exported[0] as string)).toBe(original);
	expect(
		[...files.keys()].filter((path) => path.startsWith('captures/')),
	).toHaveLength(6);
	captures.close();
	await host.close();
});
