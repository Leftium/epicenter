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
 * - Through the collection: a save sends the whole canonical file as one
 *   overwrite and keeps undeclared metadata, an edit this page never read is
 *   overwritten, a lost reply stays unknown even when a read finds its text
 *   and is sent again only by Try again, a failed save is not resent by
 *   typing, a hint never replaces a dirty draft, a failed commit is reported
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
import { readLegacyBundle } from '@epicenter/capture/legacy';
import type { FileChange as Change } from '../../../../../packages/folder/src/native/bindings.gen.js';
import fixture from '../../../fixtures/legacy-bundle.json';
import {
	QUIT_REQUESTED_EVENT,
	SERVICE_STOPPED_EVENT,
} from './shell-lifetime.js';
import { CAPTURE_FOLDER_ID } from './types.js';

const ROOT = '/Users/someone/Epicenter/so.epicenter.capture';
const PLUGIN = 'plugin:epicenter-folder|';
const FILES_CHANGED = 'plugin:epicenter-folder:folder-files-changed';
const SNAPSHOT_CHANGED = 'plugin:epicenter-folder:folder-snapshot-changed';

type Call = { cmd: string; args: Record<string, unknown> };
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

const hashOf = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

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

function own({ cmd, args }: Call): unknown {
	const read = (path: string) => {
		const bytes = files.get(path);
		if (bytes === undefined) return undefined;
		return { bytes: Array.from(bytes), sha256: hashOf(bytes) };
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
				if (change.kind === 'move')
					throw new Error('this fixture does not move files');
				const current = files.get(change.path);
				if (change.kind === 'create' && current !== undefined)
					return refuse({
						name: 'Refused',
						error: { name: 'Exists', path: change.path },
					});
				if (change.kind === 'remove' && current === undefined)
					return refuse({
						name: 'Refused',
						error: { name: 'NotFound', path: change.path },
					});
				if (
					(change.kind === 'replace' || change.kind === 'remove') &&
					change.expectedSha256 != null
				) {
					const actualSha256 = current === undefined ? null : hashOf(current);
					if (actualSha256 !== change.expectedSha256)
						return refuse({
							name: 'Refused',
							error: {
								name: 'Conflict',
								path: change.path,
								expectedSha256: change.expectedSha256,
								actualSha256,
							},
						});
				}
			}
			for (const change of changes) {
				if (change.kind === 'move')
					throw new Error('this fixture does not move files');
				if (change.kind === 'remove') files.delete(change.path);
				else files.set(change.path, Uint8Array.from(change.bytes));
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

/** A draft once its editor has opened. */
async function ready<TDraft extends { ready: Promise<void> }>(
	draft: TDraft | undefined,
): Promise<TDraft> {
	if (!draft) throw new Error('no draft');
	await draft.ready;
	return draft;
}

const encode = (source: string) => new TextEncoder().encode(source);

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
		() => refuse({ name: 'UnknownScope', scope: CAPTURE_FOLDER_ID }),
		`no folder registered as '${CAPTURE_FOLDER_ID}'`,
	],
	[
		'a window the scope does not allow',
		() =>
			refuse({
				name: 'WindowNotPermitted',
				scope: CAPTURE_FOLDER_ID,
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
		protocol: 4,
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

	emit(FILES_CHANGED, {
		scope: 'so.epicenter.todos',
		revision: 1,
		paths: [PATH],
	});
	expect(hints).toEqual([]);
	emit(FILES_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		revision: 2,
		paths: [PATH],
	});
	expect(hints).toEqual([[]]);

	stop();
	emit(FILES_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		revision: 3,
		paths: [PATH],
	});
	expect(hints).toHaveLength(1);
	await host.close();
});

test('a shell that refuses the quit listener still opens the folder and states the problem', async () => {
	refusedListens.add(QUIT_REQUESTED_EVENT);

	const host = await openCaptureHost();

	expect(host.quitProtectionProblem).toContain('event.listen not allowed');
	put(PATH, SAVED);
	const listed = await host.folder.tables.captures.list();
	expect(listed.data?.map((item) => item.path)).toEqual([PATH]);
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
	emit(FILES_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		revision: 1,
		paths: [PATH],
	});
	expect(hints).toBe(1);
	await second.close();
	expect(listening()).toBe(0);
});

/** SAVED as a save writes it: canonical frontmatter, the body byte for byte. */
const CANONICAL = SAVED.replace(
	'capturedAt: 2026-10-01T10:30:00+08:00\ncustom: kept\n',
	'"capturedAt": "2026-10-01T10:30:00+08:00"\n"custom": "kept"\n',
);

test('a save sends the whole canonical file as one overwrite and keeps metadata Capture does not declare', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];

	draft.newThought = 'second';
	expect(draft.addThought()).toBe(true);
	await draft.save();

	const expected = `${CANONICAL}- second\n`;
	expect(text(PATH)).toBe(expected);
	expect(sent('apply')).toHaveLength(1);
	expect(sent('apply')[0]?.args.changes).toEqual([
		{ kind: 'overwrite', path: PATH, bytes: Array.from(encode(expected)) },
	]);
	expect(draft.notice).toBeUndefined();
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await host.close();
});

test('an edit made elsewhere that this page never read is overwritten by its save', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	put(PATH, `${SAVED}- from another window\n`);

	draft.inputText('Mine');
	await draft.save();

	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nMine\n'));
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await host.close();
});

test('a save whose reply is lost stays unknown, even when a read finds its text, and only Try again sends it again', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	overrides.apply = (_call, reply) => {
		reply();
		throw new Error('the webview lost its IPC connection');
	};

	draft.inputText('Mine');
	await draft.save();

	expect(sent('apply')).toHaveLength(1);
	const notice = draft.notice;
	expect(notice?.kind).toBe('unconfirmed');
	// The read after it found the text; that confirms nothing.
	expect(notice?.kind === 'unconfirmed' && notice.fileHoldsMine).toBe(true);
	expect(draft.text).toBe('Mine');

	// Typing more, saving, and settling send nothing again by themselves.
	draft.inputText('Mine, more');
	await draft.save();
	expect(await captures.settleAll()).toBe(1);
	expect(sent('apply')).toHaveLength(1);
	expect(draft.notice?.kind).toBe('unconfirmed');
	expect(draft.text).toBe('Mine, more');

	delete overrides.apply;
	await draft.saveMine();
	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nMine, more\n'));
	expect(draft.notice).toBeUndefined();
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await host.close();
});

test('a failed save keeps the draft, is not resent by typing, and Try again sends it', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });

	draft.inputText('Mine');
	await draft.save();
	expect(draft.notice?.kind).toBe('failed');
	expect(text(PATH)).toBe(SAVED);

	draft.inputText('Mine, more');
	await draft.save();
	expect(sent('apply')).toHaveLength(1);
	expect(captures.unsettled).toBe(1);

	delete overrides.apply;
	await draft.saveMine();
	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nMine, more\n'));
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

test('taking the saved file answers an unknown outcome so typing saves again; a matching read alone does not', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	overrides.apply = (_call, reply) => {
		reply();
		throw new Error('the webview lost its IPC connection');
	};
	draft.inputText('Mine');
	await draft.save();
	delete overrides.apply;
	expect(draft.notice?.kind).toBe('unconfirmed');

	// The read after it holds this text, and still nothing is sent by typing.
	draft.inputText('Mine, more');
	await draft.save();
	expect(sent('apply')).toHaveLength(1);

	draft.discardMine();
	expect(draft.text).toBe('Mine');
	expect(draft.notice).toBeUndefined();
	// The outcome stays what it was: unknown, never saved.
	expect(draft.editor?.lastSave?.kind).toBe('unconfirmed');

	draft.inputText('Mine, later');
	await draft.save();
	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nMine, later\n'));
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

test('taking the saved file after a failed save lets typing save again', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });
	draft.inputText('Mine');
	await draft.save();
	delete overrides.apply;
	expect(draft.notice?.kind).toBe('failed');

	draft.discardMine();
	expect(draft.text).toBe('Text');
	expect(draft.notice).toBeUndefined();
	expect(draft.editor?.lastSave?.kind).toBe('failed');

	draft.inputText('Typed after');
	await draft.save();
	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nTyped after\n'));
	await captures.close();
	await host.close();
});

for (const outcome of ['failed', 'unknown'] as const)
	for (const [read, kind] of [
		['a file that cannot be read', 'unreadable'],
		['a file that is not a capture', 'invalid'],
		['an edit made elsewhere', 'changed'],
	] as const)
		test(`after a ${outcome} save, ${read} still holds saving, and only its own choice writes`, async () => {
			put(PATH, SAVED);
			const { host, captures } = await opened();
			const draft = await ready(captures.open('one'));
			calls = [];
			overrides.apply =
				outcome === 'failed'
					? () => refuse({ name: 'Refused', error: { name: 'Closed' } })
					: (_call, reply) => {
							reply();
							throw new Error('the webview lost its IPC connection');
						};
			draft.inputText('Mine');
			await draft.save();
			delete overrides.apply;
			const history = draft.editor?.lastSave;
			expect(draft.outcome?.kind).toBe(
				outcome === 'failed' ? 'failed' : 'unconfirmed',
			);

			// Typing goes on, then the file changes elsewhere and is read here.
			draft.inputText('More');
			if (kind === 'unreadable')
				files.set(PATH, new Uint8Array([0xff, 0xfe, 0x00]));
			else
				put(
					PATH,
					kind === 'invalid'
						? SAVED.replace('custom: kept', 'custom: !tag kept')
						: `${SAVED}- from another program\n`,
				);
			await draft.check();
			const before = sent('apply').length;

			// The outcome is still shown, and so is what the read found.
			expect(draft.outcome).toBeDefined();
			expect(draft.review?.kind).toBe(kind);
			await draft.save();
			expect(await captures.settleAll()).toBe(1);
			expect(sent('apply')).toHaveLength(before);
			expect(draft.editor?.lastSave).toBe(history);

			if (kind === 'unreadable') {
				// It cannot be reviewed, so even the explicit save writes nothing.
				await draft.saveMine();
				expect(sent('apply')).toHaveLength(before);
				expect(draft.refusal).toContain('cannot be read');
			} else if (kind === 'changed') {
				// Taking the saved file answers the outcome; typing then saves.
				draft.loadSaved();
				expect(draft.outcome).toBeUndefined();
				expect(draft.editor?.lastSave).toBe(history);
				draft.inputText('Later');
				await draft.save();
				expect(sent('apply')).toHaveLength(before + 1);
				expect(text(PATH)).toContain('\nLater\n');
			} else {
				// Keeping my draft over the reviewed file is an explicit save.
				await draft.saveMine();
				expect(sent('apply')).toHaveLength(before + 1);
				expect(text(PATH)).toContain('\nMore\n');
				expect(draft.outcome).toBeUndefined();
			}
			await captures.close({ discard: true });
			await host.close();
		});

test('save B admitted, typing C, then D written elsewhere: B is the receipt, C is kept, and D stops later saves', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	const D = `${SAVED}- from another program\n`;
	const landing = Promise.withResolvers<void>();
	overrides.apply = async (_call, reply) => {
		await landing.promise;
		const replied = reply();
		// Another program writes as soon as B is on disk.
		put(PATH, D);
		return replied;
	};

	draft.inputText('B');
	const saving = draft.save();
	draft.inputText('C');
	landing.resolve();
	await saving;
	delete overrides.apply;

	const B = CANONICAL.replace('\nText\n', '\nB\n');
	const lastSave = draft.editor?.lastSave;
	expect(lastSave?.kind === 'saved' && lastSave.receipt.source).toBe(B);
	expect(draft.text).toBe('C');
	const notice = draft.notice;
	expect(notice?.kind === 'changed' && notice.revision.source).toBe(D);
	expect(await captures.settleAll()).toBe(1);
	expect(sent('apply')).toHaveLength(1);
	expect(text(PATH)).toBe(D);
	await captures.close();
	await host.close();
});

test('closing waits for a save already sent, and nothing typed after it is sent', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	const landing = Promise.withResolvers<void>();
	overrides.apply = async (_call, reply) => {
		await landing.promise;
		return reply();
	};

	draft.inputText('Submitted');
	const saving = draft.save();
	draft.inputText('Typed later');
	let closed = false;
	const closing = captures
		.close({ discard: true })
		.then(() => host.close())
		.then(() => {
			closed = true;
		});
	await Bun.sleep(5);
	expect(closed).toBe(false);

	landing.resolve();
	await saving;
	await closing;
	expect(text(PATH)).toBe(CANONICAL.replace('\nText\n', '\nSubmitted\n'));
	expect(sent('apply')).toHaveLength(1);
	expect(draft.editor?.lastSave?.kind).toBe('saved');
	expect(draft.text).toBe('Typed later');
});

test('closing waits for a raw write already sent before the folder is let go', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await ready(captures.open('one'));
	calls = [];
	const landing = Promise.withResolvers<void>();
	overrides.apply = async (_call, reply) => {
		await landing.promise;
		return reply();
	};

	const withKey = draft.source.replace(
		'\n---\n',
		'\n"unknownKey": "kept"\n---\n',
	);
	draft.inputSource(withKey);
	const writing = draft.writeRaw();
	let closed = false;
	const closing = captures
		.close()
		.then(() => host.close())
		.then(() => {
			closed = true;
		});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	expect(sent('detach')).toEqual([]);

	landing.resolve();
	await writing;
	await closing;
	expect(text(PATH)).toBe(withKey);
	expect(sent('apply')).toHaveLength(1);
	expect(sent('apply')[0]?.args.changes).toMatchObject([
		{ kind: 'replace', path: PATH },
	]);
	expect(sent('detach')).toHaveLength(1);
});

test('a hint rereads: a clean draft follows the file, a dirty one is kept and nothing is written', async () => {
	put(PATH, SAVED);
	put('captures/two.md', SAVED);
	const { host, captures } = await opened();
	host.onExternalChange(() => void captures.refresh());
	const clean = await ready(captures.open('one'));
	const dirty = await ready(captures.open('two'));
	dirty.inputText('typed here');
	calls = [];

	const outside = `${SAVED}- from another program\n`;
	put(PATH, outside);
	put('captures/two.md', outside);
	emit(FILES_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		revision: 1,
		paths: [PATH, 'captures/two.md'],
	});
	await captures.refresh();

	expect(clean.source).toBe(`${CANONICAL}- from another program\n`);
	expect(clean.dirty).toBe(false);
	expect(dirty.text).toBe('typed here');
	expect(dirty.notice?.kind).toBe('changed');
	expect(sent('apply')).toEqual([]);
	expect(text('captures/two.md')).toBe(outside);
	await captures.close();
	await host.close();
});

test('a failed commit is reported beside a saved file, and retried without rewriting it', async () => {
	const { host, captures } = await opened();
	captures.newCapture = 'Saved before history';
	const created = await captures.create();
	if (!created.ok) throw new Error(created.message);
	const saved = text(`captures/${created.stem}.md`);

	emit(SNAPSHOT_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
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
	await captures.close();
	await host.close();
});

test('a folder its owner closed is reported as stopped; a stopped service is not', async () => {
	const { host, captures } = await opened();
	host.onServiceStopped(() => captures.markServiceStopped());

	emit(SERVICE_STOPPED_EVENT);
	expect(captures.serviceStopped).toBe(true);
	expect(captures.folderStopped).toBe(false);

	emit(SNAPSHOT_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		sequence: 1,
		snapshot: wireSnapshot({ closed: true }),
	});
	expect(captures.folderStopped).toBe(true);

	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });
	captures.newCapture = 'typed after the folder closed';
	const created = await captures.create();
	expect(created.ok).toBe(false);
	expect(captures.newCapture).toBe('typed after the folder closed');
	await captures.close();
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
	await expect(captures.importLegacy(read.bundle)).rejects.toThrow(
		'Nothing was imported',
	);
	expect(lost).toBe(1);
	const exported = [...files.keys()].filter((path) =>
		path.startsWith('recovery/legacy-export-'),
	);
	expect(exported).toHaveLength(1);
	const original = text(exported[0] as string);

	delete overrides.apply;
	const retry = await captures.importLegacy(read.bundle);
	expect(retry.complete).toBe(true);
	expect(retry.documents.map((document) => document.status)).toEqual(
		Array.from({ length: 6 }, () => 'created'),
	);
	expect(retry.receipt.status).toBe('written');
	expect(text(exported[0] as string)).toBe(original);

	calls = [];
	const again = await captures.importLegacy(read.bundle);
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toHaveLength(6);
	// The export and the report are found identical; nothing is replaced.
	expect(text(exported[0] as string)).toBe(original);
	expect(
		[...files.keys()].filter((path) => path.startsWith('captures/')),
	).toHaveLength(6);
	await captures.close();
	await host.close();
});
