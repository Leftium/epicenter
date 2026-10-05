/**
 * Epicenter Host Leaf Tests
 *
 * The desktop leaf over the real `@epicenter/folder/tauri` adapter and the
 * folder's real row editor, with the shell's `invoke` and events scripted.
 * The scripted owner keeps files in memory and checks versions and presence
 * the way the shell's owner does; it stands in for the reply shapes and lets
 * a test lose a reply or fail a read or a write. It does not run the owner.
 *
 * Key behaviors:
 * - Outside the shell, a refused window, an unregistered scope, and a missing
 *   plugin each fail the open with a reason, and leave no listener behind
 * - The page names the Capture scope and is told the directory; departure is
 *   heard on this window only
 * - Closing detaches this page once, and a sibling page keeps saving
 * - A save sends the whole canonical file as one replacement of the existing
 *   file and keeps undeclared metadata; it never creates one
 * - A lost reply is unknown, shown exactly, and never sent again by typing;
 *   Try again sends exactly the latest accepted text
 * - Failed A, then B, then C on disk: B and the failure stay; Discard my
 *   changes reloads C through the same editor
 * - A failed reload keeps the text and the failure; the next save replaces
 *   whatever the file holds, a corrupt file included
 * - A removed file is never written back by saving; putting it back is a
 *   create, and a file that came back is replaced only by Try again
 * - A change hint relists the folder and never reads into an open capture
 * - Closing waits for every admitted save
 * - A failed commit is reported beside a saved file; a closed folder is
 *   reported as stopped
 * - An import whose first save lost its reply is finished by a retry
 *
 * See also:
 * - `packages/folder/src/tauri.test.ts` for what the adapter decides
 * - `packages/folder/src/tauri-native.test.ts` for the real Rust owner
 * - `departure.test.ts` for the departure wire
 */
import '../svelte-modules.test-support.js';
import { afterEach, expect, mock, test } from 'bun:test';
import { readLegacyBundle } from '@epicenter/capture/legacy';
import {
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	HOST_STOPPED_EVENT,
} from '@epicenter/epicenter/departure';
import { expectOk } from 'wellcrafted/testing';
import type { FileChange as Change } from '../../../../../packages/folder/src/native/bindings.gen.js';
import fixture from '../../../fixtures/legacy-bundle.json';
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
const listeners = new Map<string, Set<(event: { payload: unknown }) => void>>();
/** Events heard through this window only, by event name. */
const windowListeners = new Map<string, Set<() => void>>();
const files = new Map<string, Uint8Array>();
const sessions = new Set<number>();
let nextSession = 1;

const hashOf = (bytes: Uint8Array): string =>
	new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

const wireSnapshot = (overridden: Record<string, unknown> = {}) => ({
	branch: 'main',
	remote: null,
	commitOnEdit: true,
	pendingIncoming: null,
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
				// A replacement requires its file, guarded or not: nothing is put back.
				if (
					(change.kind === 'remove' || change.kind === 'replace') &&
					current === undefined &&
					change.expectedSha256 == null
				)
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

/** The departure status the host reports; this file only reads it. */
const IDLE = { version: 1, generation: 1, phase: 'idle' };

mock.module('@tauri-apps/api/core', () => ({
	isTauri: () => inShell,
	async invoke(name: string, args: Record<string, unknown> = {}) {
		const call = { cmd: name.replace(PLUGIN, ''), args };
		calls.push(call);
		if (name === DEPARTURE_STATUS_COMMAND) return IDLE;
		const override = overrides[call.cmd];
		return override ? override(call, () => own(call)) : own(call);
	},
}));
mock.module('@tauri-apps/api/event', () => ({
	listen(name: string, callback: (event: { payload: unknown }) => void) {
		const set = listeners.get(name) ?? new Set();
		listeners.set(name, set);
		set.add(callback);
		return Promise.resolve(() => set.delete(callback));
	},
}));
mock.module('@tauri-apps/api/webviewWindow', () => ({
	getCurrentWebviewWindow: () => ({
		label: 'capture',
		listen(name: string, callback: () => void) {
			const set = windowListeners.get(name) ?? new Set();
			windowListeners.set(name, set);
			set.add(callback);
			return Promise.resolve(() => set.delete(callback));
		},
	}),
}));

const { openCaptureHost, openDeparture } = await import(
	'./folder.epicenter-host.js'
);
const { createCaptures } = await import('../captures.svelte.ts');

function emit(name: string, payload?: unknown) {
	for (const listener of listeners.get(name) ?? []) listener({ payload });
}

const sent = (cmd: string) => calls.filter((call) => call.cmd === cmd);
const listening = () =>
	[...listeners.values()].reduce((count, set) => count + set.size, 0);
const text = (path: string) => new TextDecoder().decode(files.get(path));
const put = (path: string, source: string | Uint8Array) =>
	files.set(
		path,
		typeof source === 'string' ? new TextEncoder().encode(source) : source,
	);

const SAVED =
	'---\ncapturedAt: 2026-10-01T10:30:00+08:00\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n  nested line\n';
const PATH = 'captures/one.md';
/** SAVED as a save writes it: canonical frontmatter, the body byte for byte. */
const CANONICAL = SAVED.replace(
	'capturedAt: 2026-10-01T10:30:00+08:00\ncustom: kept\n',
	'"capturedAt": "2026-10-01T10:30:00+08:00"\n"custom": "kept"\n',
);
const withText = (body: string) => CANONICAL.replace('\nText\n', `\n${body}\n`);
const LOST = 'the webview lost its IPC connection';

async function opened() {
	const host = await openCaptureHost();
	const captures = createCaptures(host);
	await captures.refresh();
	return { host, captures };
}

/** The open capture at PATH, once its editor has opened. */
async function openOne(
	captures: Awaited<ReturnType<typeof opened>>['captures'],
) {
	const draft = captures.open('one');
	if (!draft) throw new Error('no draft');
	await draft.ready;
	return draft;
}

const encode = (source: string) => new TextEncoder().encode(source);
const replaced = () =>
	sent('apply').flatMap((call) => call.args.changes as Change[]);

afterEach(() => {
	inShell = true;
	calls = [];
	overrides = {};
	listeners.clear();
	windowListeners.clear();
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
			throw new Error(LOST);
		},
		LOST,
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

	expect(failure).toBeInstanceOf(Error);
	expect((failure as Error).message).toBe(
		'The folder could not be opened: epicenter-folder.attach not allowed',
	);
	expect(calls.map((call) => call.cmd)).toEqual(['attach']);
	expect(listening()).toBe(0);
});

test('the page names the Capture scope and is told the directory', async () => {
	const host = await openCaptureHost();

	expect(sent('attach')[0]?.args).toEqual({
		scope: 'so.epicenter.capture',
		protocol: 6,
	});
	expect(host.location).toEqual({ kind: 'directory', root: ROOT });
	await host.close();
});

test('departure is heard on this window only, registered before its first status read', async () => {
	const departure = openDeparture();
	if (!departure) throw new Error('the desktop leaf has a departure gate');
	await departure.ready;
	// Targeted at this window, not any window's global listener.
	expect([...windowListeners.keys()].sort()).toEqual(
		[DEPARTURE_CHANGED_EVENT, HOST_STOPPED_EVENT].sort(),
	);
	expect(listeners.has(DEPARTURE_CHANGED_EVENT)).toBe(false);
	expect(calls.map((call) => call.cmd)).toEqual([DEPARTURE_STATUS_COMMAND]);
	expect(departure.everIdle).toBe(true);

	let stopped = 0;
	departure.onHostStopped(() => stopped++);
	for (const listener of windowListeners.get(HOST_STOPPED_EVENT) ?? [])
		listener();
	expect(stopped).toBe(1);
	departure.close();
	expect(
		[...windowListeners.values()].reduce((count, set) => count + set.size, 0),
	).toBe(0);
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
	emit(FILES_CHANGED, { scope: CAPTURE_FOLDER_ID, revision: 2, paths: [PATH] });
	expect(hints).toEqual([[]]);

	stop();
	emit(FILES_CHANGED, { scope: CAPTURE_FOLDER_ID, revision: 3, paths: [PATH] });
	expect(hints).toHaveLength(1);
	await host.close();
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
	expectOk(await second.folder.files.create(PATH, SAVED));
	expect(text(PATH)).toBe(SAVED);
	await second.close();
	expect(listening()).toBe(0);
});

test('a save sends the whole canonical file as one replacement of the existing file and keeps metadata Capture does not declare', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	calls = [];

	draft.inputNewThought('second');
	expect(draft.addThought()).toBe(true);
	await draft.settle();

	const expected = `${CANONICAL}- second\n`;
	expect(text(PATH)).toBe(expected);
	expect(sent('apply')).toHaveLength(1);
	expect(replaced()).toMatchObject([
		{ kind: 'replace', path: PATH, bytes: Array.from(encode(expected)) },
	]);
	expect(draft.notice).toBeUndefined();
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await host.close();
});

test('an edit made elsewhere that this page never read is replaced by its save', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	put(PATH, `${SAVED}- from another window\n`);

	draft.inputText('Mine');
	await draft.settle();

	expect(text(PATH)).toBe(withText('Mine'));
	expect(draft.unsettled).toBe(false);
	await captures.close();
	await host.close();
});

test('a save whose reply is lost stays unknown, shown exactly; only Try again sends again', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	calls = [];
	const scratch =
		'the displaced file was kept at .git/epicenter/scratch/one-1a2b';
	overrides.apply = (_call, reply) => {
		reply();
		return refuse({
			name: 'Unconfirmed',
			path: PATH,
			operation: 'replace',
			cause: scratch,
		});
	};

	draft.inputText('Mine');
	await draft.settle();
	delete overrides.apply;
	expect(sent('apply')).toHaveLength(1);
	const notice = draft.notice;
	expect(notice?.kind).toBe('unconfirmed');
	// The exact report, with where the displaced file was kept.
	expect(notice?.kind === 'unconfirmed' && notice.message).toContain(scratch);
	expect(text(PATH)).toBe(withText('Mine'));

	// Typing and settling send nothing again by themselves.
	draft.inputText('Mine, more');
	expect(await captures.departure.settle()).toBe(1);
	expect(sent('apply')).toHaveLength(1);
	expect(draft.text).toBe('Mine, more');

	// Try again is a new attempt with the newest text.
	draft.retry();
	await draft.settle();
	expect(sent('apply')).toHaveLength(2);
	expect(text(PATH)).toBe(withText('Mine, more'));
	expect(draft.notice).toBeUndefined();
	expect(captures.unsettled).toBe(0);
	await captures.close();
	await host.close();
});

test('Try again with nothing newer sends exactly the accepted text, Source comments and quoting included', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	const handWritten = SAVED.replace(
		'custom: kept\n',
		"# by hand\ncustom: 'kept, quoted'\n",
	);
	overrides.apply = () =>
		refuse({
			name: 'Refused',
			error: {
				name: 'Io',
				path: PATH,
				operation: 'replace',
				cause: 'disk full',
			},
		});
	draft.setView('source');
	draft.inputSource(handWritten);
	await draft.settle();
	expect(draft.notice).toMatchObject({ kind: 'failed', missing: false });
	expect(text(PATH)).toBe(SAVED);
	delete overrides.apply;
	calls = [];

	draft.retry();
	await draft.settle();
	expect(replaced()).toMatchObject([
		{ kind: 'replace', path: PATH, bytes: Array.from(encode(handWritten)) },
	]);
	expect(text(PATH)).toBe(handWritten);
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

test('failed A, then B, then C on disk: B and the failure stay; discarding reloads C through the same editor', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });

	draft.inputText('A');
	await draft.settle();
	delete overrides.apply;
	expect(draft.notice?.kind).toBe('failed');
	draft.inputText('B');
	const C = `${SAVED}- from another program\n`;
	put(PATH, C);
	await captures.refresh();

	// B is shown with the failure; C is not taken, and nothing is sent.
	expect(draft.text).toBe('B');
	expect(draft.notice?.kind).toBe('failed');
	expect(await captures.departure.settle()).toBe(1);
	expect(text(PATH)).toBe(C);
	expect(sent('apply')).toHaveLength(1);

	expect(await draft.reload()).toBe(true);
	expect(draft.notice).toBeUndefined();
	expect(draft.unsettled).toBe(false);
	expect(draft.source).toBe(C);
	expect(draft.document.thoughts.map((thought) => thought.text)).toEqual([
		'first\nnested line',
		'from another program',
	]);
	expect(sent('apply')).toHaveLength(1);
	await captures.close();
	await host.close();
});

test('a failed reload keeps the text and the failure, and writes nothing', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	const io = (operation: string) => ({
		name: 'Io',
		path: PATH,
		operation,
		cause: 'the disk went away',
	});
	overrides.apply = () => refuse({ name: 'Refused', error: io('replace') });

	draft.inputText('Mine');
	await draft.settle();
	overrides.read = () => refuse(io('read'));
	expect(await draft.reload()).toBe(false);
	expect(draft.refusal).toContain('could not be read');
	expect(draft.notice?.kind).toBe('failed');
	expect(draft.source).toBe(withText('Mine'));
	expect(sent('apply')).toHaveLength(1);
	await captures.close();
	await host.close();
});

test('a corrupt file is reported by Reload and replaced by the next save', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	put(PATH, new Uint8Array([0xff, 0xfe, 0x00]));
	expect(await draft.reload()).toBe(false);
	expect(draft.refusal).toContain('could not be read');
	expect(draft.source).toBe(SAVED);
	expect(draft.notice).toBeUndefined();
	expect(files.get(PATH)).toEqual(new Uint8Array([0xff, 0xfe, 0x00]));

	// The person's next change replaces it whole: the latest save wins.
	draft.inputText('Mine');
	await draft.settle();
	expect(text(PATH)).toBe(withText('Mine'));
	expect(draft.structured).toBe(true);
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

test('a removed file is never written back by saving: the failure says so, the text stays, and putting it back is a create', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	files.delete(PATH);
	draft.inputText('Mine');
	await draft.settle();
	expect(draft.notice).toMatchObject({ kind: 'failed', missing: true });
	expect(files.has(PATH)).toBe(false);

	draft.retry();
	await draft.settle();
	expect(files.has(PATH)).toBe(false);
	expect(draft.source).toBe(withText('Mine'));
	expect(replaced().every((change) => change.kind === 'replace')).toBe(true);

	expect(await draft.restore()).toEqual({ ok: true });
	expect(replaced().at(-1)).toMatchObject({ kind: 'create', path: PATH });
	expect(text(PATH)).toBe(withText('Mine'));
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

/** A file another program wrote where this window's save found none. */
const C =
	'---\ncapturedAt: 2026-10-01T00:00:00.000Z\nsource: other\n---\n\nC\n';

/** Save B fails because the file is gone; another program then writes C. */
async function cameBack() {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	files.delete(PATH);
	draft.inputText('Mine, B');
	await draft.settle();
	const { notice } = draft;
	if (notice?.kind !== 'failed' || !notice.missing)
		throw new Error('fixture: save B did not fail as missing');
	put(PATH, C);
	calls = [];
	return { host, captures, draft, B: withText('Mine, B') };
}

test('failed B, then C on disk: putting it back writes nothing over C, and Try again replaces C with exactly B', async () => {
	const { host, captures, draft, B } = await cameBack();
	expect(await draft.restore()).toMatchObject({ ok: false });
	expect(text(PATH)).toBe(C);
	expect(draft.notice).toMatchObject({ kind: 'failed', missing: true });
	expect(await captures.departure.settle()).toBe(1);
	expect(text(PATH)).toBe(C);
	expect(replaced().every((change) => change.kind === 'create')).toBe(true);

	draft.retry();
	await draft.settle();
	expect(replaced().at(-1)).toMatchObject({
		kind: 'replace',
		path: PATH,
		bytes: Array.from(encode(B)),
	});
	expect(text(PATH)).toBe(B);
	expect(draft.notice).toBeUndefined();
	await captures.close();
	await host.close();
});

test('failed B, then C on disk: discarding takes C, metadata and all, and writes nothing', async () => {
	const { host, captures, draft } = await cameBack();
	expect(await draft.reload()).toBe(true);
	expect(draft.source).toBe(C);
	expect(draft.notice).toBeUndefined();
	expect(sent('apply')).toEqual([]);
	await captures.close();
	await host.close();
});

test('closing waits for a save already sent and the latest text after it, and only then detaches', async () => {
	put(PATH, SAVED);
	const { host, captures } = await opened();
	const draft = await openOne(captures);
	calls = [];
	const landing = Promise.withResolvers<void>();
	overrides.apply = async (_call, reply) => {
		await landing.promise;
		return reply();
	};

	draft.inputText('Submitted');
	draft.inputText('Typed later');
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
	await closing;
	expect(text(PATH)).toBe(withText('Typed later'));
	expect(sent('apply')).toHaveLength(2);
	expect(sent('detach')).toHaveLength(1);
});

test('a hint relists the folder and never reads into an open capture', async () => {
	put(PATH, SAVED);
	put('captures/two.md', SAVED);
	const { host, captures } = await opened();
	host.onExternalChange(() => void captures.refresh());
	const clean = await openOne(captures);
	const typed = captures.open('two');
	if (!typed) throw new Error('fixture');
	await typed.ready;
	typed.inputText('typed here');
	await typed.settle();
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

	expect(clean.source).toBe(SAVED);
	expect(clean.notice).toBeUndefined();
	expect(typed.text).toBe('typed here');
	expect(typed.notice).toBeUndefined();
	expect(sent('apply')).toEqual([]);
	expect(text('captures/two.md')).toBe(outside);
	// Reloading is the person's choice.
	expect(await clean.reload()).toBe(true);
	expect(clean.source).toBe(outside);
	await captures.close();
	await host.close();
});

test('a failed commit is reported beside a saved file, and retried without rewriting it', async () => {
	const { host, captures } = await opened();
	captures.inputNewCapture('Saved before history');
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

test('a folder its owner closed is reported as stopped, and the text typed stays', async () => {
	const { host, captures } = await opened();
	emit(SNAPSHOT_CHANGED, {
		scope: CAPTURE_FOLDER_ID,
		sequence: 1,
		snapshot: wireSnapshot({ closed: true }),
	});
	expect(captures.folderStopped).toBe(true);
	expect(captures.serviceStopped).toBe(false);

	overrides.apply = () =>
		refuse({ name: 'Refused', error: { name: 'Closed' } });
	captures.inputNewCapture('typed after the folder closed');
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
		throw new Error(LOST);
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
	expect(text(exported[0] as string)).toBe(original);

	const again = await captures.importLegacy(read.bundle);
	expect(again.documents).toEqual([]);
	expect(again.alreadyImported).toHaveLength(6);
	expect(
		[...files.keys()].filter((path) => path.startsWith('captures/')),
	).toHaveLength(6);
	await captures.close();
	await host.close();
});
