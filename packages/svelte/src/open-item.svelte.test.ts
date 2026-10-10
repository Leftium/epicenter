/**
 * Open Item and Admissions Tests
 *
 * Drives the one-open-item slot over stand-in sessions, and admissions over
 * plain promises.
 *
 * Key behaviors:
 * - Opening the item already shown does nothing
 * - A load that answers after a newer open is released and never shown
 * - A failed save answers `unsaved` with its session; only that session's discard proceeds
 * - Reload theirs closes a gone file and reopens one that cannot be shown
 * - `removeOpen` releases first, removes what the last save confirmed, and reopens when refused
 * - A command counts from its call, before its first await
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { FileCapture, SaveState } from '@epicenter/folder';
import { Err, Ok } from 'wellcrafted/result';
import type { Reread } from './edit-session.svelte.js';
import type { OpenSession } from './open-item.svelte.js';

const { createOpenItem } = await import('./open-item.svelte.ts');
const { createAdmissions } = await import('./admissions.svelte.ts');

type Failure = { readonly name: string; readonly message: string };

function fakeSession(path: string) {
	let state: SaveState<Failure> = {
		status: 'saved',
		file: { path, sha256: 'a'.repeat(64) },
	};
	let reread: Reread<unknown, unknown> = {
		kind: 'value',
		file: state.file,
		value: '',
	};
	const session = {
		released: false,
		get path() {
			return path;
		},
		get state() {
			return state;
		},
		fail() {
			state = {
				status: 'error',
				error: { name: 'Io', message: 'disk' },
				file: state.file,
			};
		},
		willReread(next: Reread<unknown, unknown>) {
			reread = next;
		},
		settled: async () => state,
		release() {
			session.released = true;
		},
		adopt: async () => false,
		keepMine: async () => Ok(undefined),
		reloadTheirs: async () => Ok(reread),
	};
	return session satisfies OpenSession;
}

type Session = ReturnType<typeof fakeSession>;
type Item = { readonly key: string; readonly session: Session };

function slot() {
	const loads: string[] = [];
	const gates = new Map<string, PromiseWithResolvers<void>>();
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			await gates.get(key)?.promise;
			return { key, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
	});
	return {
		open,
		loads,
		hold(key: string) {
			const gate = Promise.withResolvers<void>();
			gates.set(key, gate);
			return () => {
				gates.delete(key);
				gate.resolve();
			};
		},
	};
}

test('opening the item already shown does nothing', async () => {
	const { open, loads } = slot();
	await open.open('a');
	const first = open.session;
	expect(await open.open('a')).toEqual({ kind: 'done', left: false });
	expect(open.session).toBe(first);
	expect(loads).toEqual(['a']);
});

test('a load that answers after a newer open is released and never shown', async () => {
	const { open, hold } = slot();
	const release = hold('a');
	const late = open.open('a');
	await open.open('b');
	release();
	expect(await late).toEqual({ kind: 'superseded' });
	expect(open.item?.key).toBe('b');
});

test('a failed save answers unsaved with its session, and only its discard proceeds', async () => {
	const { open } = slot();
	await open.open('a');
	const a = open.session!;
	a.fail();
	expect(open.unsaved).toBe(true);
	expect(await open.open('b')).toEqual({ kind: 'unsaved', session: a });
	expect(open.item?.key).toBe('a');
	const other = fakeSession('x');
	expect(await open.open('b', { discard: other })).toEqual({
		kind: 'unsaved',
		session: a,
	});
	expect(await open.open('b', { discard: a })).toEqual({
		kind: 'done',
		left: true,
	});
	expect(a.released).toBe(true);
	expect(open.item?.key).toBe('b');
});

test('Reload theirs closes a file that is gone and reopens one that cannot be shown', async () => {
	const { open, loads } = slot();
	await open.open('a');
	const a = open.session!;
	a.willReread({
		kind: 'other',
		file: { path: 'a', sha256: 'b'.repeat(64) },
		detail: 'binary',
	});
	expect((await open.reloadTheirs(a))?.data).toBe('reopened');
	expect(a.released).toBe(true);
	expect(open.session).not.toBe(a);
	expect(loads).toEqual(['a', 'a']);

	const reopened = open.session!;
	reopened.willReread({ kind: 'gone' });
	expect((await open.reloadTheirs(reopened))?.data).toBe('closed');
	expect(open.item).toBeUndefined();
	// A session that is no longer open is not acted on.
	expect(await open.reloadTheirs(reopened)).toBeUndefined();
});

test('removeOpen releases first, removes what was saved last, and reopens when refused', async () => {
	const { open } = slot();
	await open.open('a');
	const a = open.session!;
	let removed: FileCapture | undefined;
	const refused = await open.removeOpen(a, async (file) => {
		removed = file;
		expect(a.released).toBe(true);
		return Err({ name: 'Conflict', message: 'changed' });
	});
	expect(refused?.error?.name).toBe('Conflict');
	expect(removed?.path).toBe('a');
	const reopened = open.session!;
	expect(reopened).not.toBe(a);

	const done = await open.removeOpen(reopened, async () => Ok(undefined));
	expect(done?.error).toBeNull();
	expect(open.item).toBeUndefined();
});

test('a command counts from its call, before its first await', async () => {
	const admissions = createAdmissions();
	const gate = Promise.withResolvers<void>();
	let started = false;
	const run = admissions.command(async (value: number) => {
		started = true;
		await gate.promise;
		return value * 2;
	});
	const running = run(21);
	expect(started).toBe(true);
	expect(admissions.busy).toBe(true);
	let quiet = false;
	const waiting = admissions.quiet().then(() => {
		quiet = true;
	});
	await Bun.sleep(5);
	expect(quiet).toBe(false);
	gate.resolve();
	expect(await running).toBe(42);
	await waiting;
	expect(admissions.busy).toBe(false);
});

test('an item shown under another key than asked opens again when asked by that key', async () => {
	const loads: string[] = [];
	let repaired = false;
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			// A row whose text is not valid opens as text until it is repaired.
			const shownAs = key === 'row' && !repaired ? 'text' : key;
			return { key: shownAs, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
		keyOf: (item) => item.key,
	});
	await open.open('row');
	expect(open.shown?.key).toBe('text');
	repaired = true;
	expect(await open.open('row')).toEqual({ kind: 'done', left: true });
	expect(open.item?.key).toBe('row');
	expect(loads).toEqual(['row', 'row']);
});

test('the key follows an item renamed in place, so a reload reads the new path', async () => {
	const loads: string[] = [];
	/** Where a rename moved each session's file. */
	const moved = new Map<Session, string>();
	const open = createOpenItem<string, Item, Session>({
		async load(key) {
			loads.push(key);
			return { key, session: fakeSession(key) };
		},
		sessionOf: (item) => item.session,
		keyOf: (item) => moved.get(item.session) ?? item.key,
	});
	await open.open('old');
	moved.set(open.session!, 'new');
	expect(open.shown?.key).toBe('new');
	expect(await open.open('new')).toEqual({ kind: 'done', left: false });
	await open.reload();
	expect(loads).toEqual(['old', 'new']);
});
