/**
 * File Session Tests
 *
 * Drives the real session runes module against a folder's files held in
 * memory. The fake has the folder's own verbs, conditions, and errors, and
 * its changes wait, fail, or lose their reply only when a test says so,
 * which makes every save, review, and observation race a fixed sequence.
 *
 * Key behaviors:
 * - A clean session adopts an external change and writes nothing back
 * - A dirty session keeps its text and holds the external version apart
 * - A save takes the text as it is when asked for, and acknowledges only that
 * - A review choice names one observed version; a newer one invalidates it,
 *   and a refused choice leaves the saved base and the conflict as they were
 * - An unconfirmed save is kept as it was sent through anything else that is
 *   read, is retried exactly, and ends only by confirmation or by reading
 *   exactly its text at its path; newer typing is never sent in its place
 * - A removed file's draft is saved back exclusively, elsewhere only when its
 *   own path holds other text
 * - A move or removal carries exactly the saved capture; one whose outcome
 *   is unknown or partial is kept, and nothing more is changed
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, jest, test } from 'bun:test';
import {
	ApplyError,
	type CapturedFile,
	captureVersion,
	type FileCapture,
	FileError,
	type FileExpectation,
	type FileVersion,
	sameVersion,
} from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import type { FileSession, Observed } from './file-session.svelte.ts';

const { createFileSession } = await import('./file-session.svelte.ts');

const encoder = new TextEncoder();
const PATH = 'notes/a.md';
const ELSEWHERE = 'notes/b.md';

const versionOf = (source: string) => captureVersion(encoder.encode(source));

/** What the next change does instead of answering plainly. */
type Plan =
	| { kind: 'fail'; message: string }
	| { kind: 'throw'; message: string }
	/** The change lands; its reply is lost. */
	| { kind: 'lose' }
	/** The reply is lost first; `land()` publishes the change afterwards. */
	| { kind: 'defer' }
	/** A move creates its destination and cannot remove the original. */
	| { kind: 'partial' };

/** One change exactly as the session asked for it. */
type Request =
	| { create: string; source: string }
	| { replace: string; source: string; expected: FileVersion }
	| { move: string; to: string; expected: FileVersion }
	| { remove: string; expected: FileVersion };

type Changed<T> = Promise<Result<T, FileError | ApplyError>>;

function lostReply(path: string) {
	return FileError.Unconfirmed({
		path,
		operation: 'publishing to',
		cause: new Error('the reply was lost'),
	});
}

/**
 * One folder's files. `hold()` makes the next change wait before it checks
 * its condition, as a slow disk would; `next()` plans how it ends.
 */
function disk(initial: string | undefined) {
	const stored = new Map<string, string>();
	if (initial !== undefined) stored.set(PATH, initial);
	const notText = new Set<string>();
	let gate: Promise<void> | undefined;
	let release = () => {};
	let arrival: PromiseWithResolvers<void> | undefined;
	let plan: Plan | undefined;
	let pending: (() => Changed<unknown>) | undefined;
	/** Every change exactly as it was asked for, landed or not. */
	const requests: Request[] = [];

	async function refusal(
		path: string,
		expected: FileExpectation,
	): Promise<Result<never, FileError> | undefined> {
		const source = stored.get(path);
		const actual = source === undefined ? undefined : await versionOf(source);
		const holds =
			expected === 'absent'
				? actual === undefined
				: expected !== 'any' && sameVersion(actual, expected);
		return holds ? undefined : FileError.Conflict({ path, expected, actual });
	}

	/** Run one change the way the folder does: wait, then end as planned. */
	async function change<T>(
		path: string,
		publish: () => Changed<T>,
	): Changed<T> {
		arrival?.resolve();
		await gate;
		const chosen = plan;
		plan = undefined;
		if (chosen?.kind === 'throw') throw new Error(chosen.message);
		if (chosen?.kind === 'fail')
			return FileError.Io({ path, operation: 'write', cause: chosen.message });
		if (chosen?.kind === 'defer') {
			pending = publish;
			return lostReply(path);
		}
		const result = await publish();
		return chosen?.kind === 'lose' ? lostReply(path) : result;
	}

	function write(
		path: string,
		source: string,
		expected: FileVersion | 'absent',
	): Changed<FileCapture> {
		return change(path, async () => {
			const refused = await refusal(path, expected);
			if (refused) return refused;
			stored.set(path, source);
			notText.delete(path);
			return Ok({ path, version: await versionOf(source) });
		});
	}

	return {
		requests,
		/** The text of every write that was asked for, landed or not. */
		get asked() {
			return requests.flatMap((request) =>
				'source' in request ? [request.source] : [],
			);
		},
		at: (path = PATH) => stored.get(path),
		paths: () => [...stored.keys()].sort(),
		/** Make the next change wait. Resolves once that change has been asked for. */
		hold(): Promise<void> {
			gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			arrival = Promise.withResolvers<void>();
			return arrival.promise;
		},
		release() {
			release();
			gate = undefined;
		},
		next(value: Plan) {
			plan = value;
		},
		/** Publish the change whose reply was lost before it landed. */
		land() {
			if (pending === undefined) throw new Error('No change is waiting');
			const publish = pending;
			pending = undefined;
			return publish();
		},
		/** Another program replaces or removes a file. */
		external(source: string | undefined, path = PATH) {
			if (source === undefined) stored.delete(path);
			else stored.set(path, source);
			notText.delete(path);
		},
		/** Another program leaves bytes that are not text. */
		corrupt(path = PATH) {
			notText.add(path);
		},
		async observed(path = PATH): Promise<Observed> {
			const source = stored.get(path);
			if (source === undefined) return { kind: 'removed' };
			if (notText.has(path))
				return { kind: 'unreadable', message: 'The file is no longer text.' };
			return {
				kind: 'present',
				file: { path, source, version: await versionOf(source) },
			};
		},
		files: {
			async read(path: string): Promise<Result<CapturedFile, FileError>> {
				const source = stored.get(path);
				if (source === undefined) return FileError.NotFound({ path });
				const bytes = notText.has(path)
					? new Uint8Array([0])
					: encoder.encode(source);
				return Ok({ path, version: await captureVersion(bytes), bytes });
			},
			create(path: string, content: string | Uint8Array) {
				const source = content as string;
				requests.push({ create: path, source });
				return write(path, source, 'absent');
			},
			replace(file: FileCapture, content: string | Uint8Array) {
				const source = content as string;
				requests.push({ replace: file.path, source, expected: file.version });
				return write(file.path, source, file.version);
			},
			move(file: FileCapture, to: string): Changed<FileCapture> {
				requests.push({ move: file.path, to, expected: file.version });
				const planned = plan;
				return change(file.path, async () => {
					const source = stored.get(file.path);
					if (source === undefined)
						return FileError.NotFound({ path: file.path });
					const refused =
						(await refusal(file.path, file.version)) ??
						(await refusal(to, 'absent'));
					if (refused) return refused;
					stored.set(to, source);
					if (planned?.kind === 'partial')
						return ApplyError.Partial({
							applied: [{ kind: 'write', path: to }],
							failed: { kind: 'remove', path: file.path },
							error: FileError.Io({
								path: file.path,
								operation: 'retire',
								cause: 'the file is in use',
							}).error,
							notAttempted: [],
						});
					stored.delete(file.path);
					return Ok({ path: to, version: file.version });
				});
			},
			remove(file: FileCapture): Changed<undefined> {
				requests.push({ remove: file.path, expected: file.version });
				return change(file.path, async () => {
					if (!stored.has(file.path))
						return FileError.NotFound({ path: file.path });
					const refused = await refusal(file.path, file.version);
					if (refused) return refused;
					stored.delete(file.path);
					return Ok(undefined);
				});
			},
		},
	};
}

const sessions: FileSession[] = [];
afterEach(() => {
	// A session that ends a test dirty has an autosave timer; stop it there.
	for (const session of sessions.splice(0)) session.dispose();
	jest.useRealTimers();
});

async function open(source: string, admits: () => boolean = () => true) {
	const files = disk(source);
	const session = createFileSession(
		files.files,
		{ path: PATH, source, version: await versionOf(source) },
		{ admits },
	);
	sessions.push(session);
	return { files, session };
}

/** An open session holding `mine`, whose file another program then changed. */
async function conflicted(theirs: string | undefined) {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	files.external(theirs);
	session.observe(await files.observed());
	const reviewed = session.external;
	if (reviewed === undefined) throw new Error('No conflict was recorded');
	return { files, session, reviewed };
}

/** An open session whose save of `A` got no reply. `landed` says whether the file has it. */
async function unconfirmed({ landed }: { landed: boolean }) {
	const { files, session } = await open('one\n');
	const base = session.saved.version;
	session.input('A\n');
	files.next({ kind: landed ? 'lose' : 'defer' });
	await session.save();
	const sent = { path: PATH, source: 'A\n', expected: base };
	expect(session.attempt).toEqual({
		...sent,
		state: 'unconfirmed',
		problem: expect.stringContaining('may have completed'),
	});
	return { files, session, base, sent };
}

// ============================================================================
// Observations
// ============================================================================

test('a clean session adopts an external change without writing', async () => {
	const { files, session } = await open('one\n');
	files.external('two\n');
	expect(session.observe(await files.observed())).toBe('adopted');
	expect(session.buffer).toBe('two\n');
	expect(session.saved.source).toBe('two\n');
	expect(session.status).toBe('saved');
	await session.save();
	expect(files.requests).toEqual([]);
});

test('observing the same bytes changes nothing', async () => {
	const { files, session } = await open('one\n');
	session.input('one and mine\n');
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.buffer).toBe('one and mine\n');
});

test('a dirty session keeps its text and holds the external version apart', async () => {
	const { files, session } = await conflicted('theirs\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.saved.source).toBe('one\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
	expect(session.status).toBe('conflict');
	// Saving is paused: asking for a save writes nothing.
	await session.save();
	expect(files.requests).toEqual([]);
	expect(files.at()).toBe('theirs\n');
});

test('the same external bytes seen again are the same review target', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toBe(reviewed);
});

test('a conflict ends when the file returns to what the session agreed with', async () => {
	const { files, session } = await conflicted('theirs\n');
	files.external('one\n');
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.external).toBeUndefined();
	expect(session.status).toBe('dirty');
});

test('a removed file with a clean session is simply gone', async () => {
	const { files, session } = await open('one\n');
	files.external(undefined);
	expect(session.observe(await files.observed())).toBe('gone');
	expect(session.external).toBeUndefined();
});

test('an unreadable file keeps the draft', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	files.corrupt();
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toEqual({
		kind: 'unreadable',
		message: 'The file is no longer text.',
	});
	expect(session.buffer).toBe('mine\n');
	expect(session.unsettled).toBe(true);
});

// ============================================================================
// Saving
// ============================================================================

test('typing is saved by itself after a pause, over the capture the session holds', async () => {
	jest.useFakeTimers();
	const { files, session } = await open('one\n');
	session.input('typed\n');
	jest.advanceTimersByTime(499);
	expect(files.requests).toEqual([]);
	jest.advanceTimersByTime(1);
	await session.settle();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'typed\n', expected: await versionOf('one\n') },
	]);
	expect(session.status).toBe('saved');
});

test('a save takes the text as it is when it is asked for: typing in the same tick stays dirty', async () => {
	const { files, session } = await open('one\n');
	session.input('A\n');
	const saving = session.save();
	session.input('A and B\n');
	await saving;
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: await versionOf('one\n') },
	]);
	expect(files.at()).toBe('A\n');
	expect(session.saved).toEqual({
		path: PATH,
		source: 'A\n',
		version: await versionOf('A\n'),
	});
	expect(session.buffer).toBe('A and B\n');
	expect(session.dirty).toBe(true);
});

test('a save asked for behind another is conditional on what that one saved, not on an older base', async () => {
	const { files, session } = await open('one\n');
	session.input('A\n');
	const first = session.save();
	session.input('A and B\n');
	const second = session.save();
	await Promise.all([first, second]);
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: await versionOf('one\n') },
		{ replace: PATH, source: 'A and B\n', expected: await versionOf('A\n') },
	]);
	expect(session.status).toBe('saved');
});

test('a save asked for before a file was adopted does not write the old typing over it', async () => {
	const { files, session } = await open('one\n');
	session.input('typed\n');
	const asked = files.hold();
	const first = session.save();
	await asked;
	// A second save is asked for, and then the typing is taken back.
	const second = session.save();
	session.input('one\n');
	// Another program changes the file; the first save fails; the recheck that
	// follows it finds the session clean and adopts that file.
	files.external('theirs\n');
	expect(session.observe(await files.observed())).toBe('deferred');
	files.next({ kind: 'fail', message: 'disk full' });
	files.release();
	await Promise.all([first, second]);
	expect(session.buffer).toBe('theirs\n');
	expect(files.at()).toBe('theirs\n');
	expect(files.asked).toEqual(['typed\n']);
});

test('typing during a save stays dirty after the submitted text is acknowledged', async () => {
	const { files, session } = await open('one\n');
	session.input('A\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	expect(session.status).toBe('saving');
	expect(session.attempt).toMatchObject({ source: 'A\n', state: 'sent' });
	session.input('A and B\n');
	files.release();
	await saving;
	expect(files.asked).toEqual(['A\n']);
	expect(session.saved.source).toBe('A\n');
	expect(session.buffer).toBe('A and B\n');
	expect(session.dirty).toBe(true);
	expect(session.attempt).toBeUndefined();
});

test('a stale save is refused and the draft is kept', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	files.external('theirs\n');
	files.release();
	await saving;
	expect(files.at()).toBe('theirs\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.saved.source).toBe('one\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
	expect(session.status).toBe('conflict');
});

test('an observation during a save is rechecked when the save settles', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	// The watcher reports the path while the save is still waiting.
	expect(session.observe(await files.observed())).toBe('deferred');
	files.release();
	await saving;
	// The save landed; the deferred check found the session's own bytes.
	expect(files.at()).toBe('mine\n');
	expect(session.status).toBe('saved');
	expect(session.external).toBeUndefined();
});

test('a change that lands right after a save is caught by the deferred recheck', async () => {
	const { files, session } = await open('one\n');
	// Another program rewrites the file just after the save's write is accepted.
	const replace = files.files.replace;
	files.files.replace = async (file, content) => {
		const result = await replace(file, content);
		files.external('theirs\n');
		return result;
	};
	session.input('mine\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	expect(session.observe(await files.observed())).toBe('deferred');
	session.input('mine and more\n');
	files.release();
	await saving;
	// The save is acknowledged as what it wrote; the other file is a conflict.
	expect(session.saved.source).toBe('mine\n');
	expect(session.buffer).toBe('mine and more\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs\n' },
	});
});

test('a failed save keeps the draft and can be retried', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	files.next({ kind: 'fail', message: 'disk full' });
	await session.save();
	expect(session.status).toBe('failed');
	expect(session.failure).toContain('disk full');
	expect(session.buffer).toBe('mine\n');
	expect(files.at()).toBe('one\n');
	expect(session.unsettled).toBe(true);
	await session.retry();
	expect(session.status).toBe('saved');
	expect(files.at()).toBe('mine\n');
});

test('a file removed during a save is reported, and the draft is kept', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	files.external(undefined);
	files.release();
	await saving;
	expect(session.external).toEqual({ kind: 'removed' });
	expect(session.buffer).toBe('mine\n');
});

test('settle reports whether closing would lose anything', async () => {
	const { session } = await open('one\n');
	expect(session.unsettled).toBe(false);
	session.input('mine\n');
	expect(session.unsettled).toBe(true);
	expect(await session.settle()).toBe(true);
	expect(session.unsettled).toBe(false);
});

test('input that is not admitted is not taken, and a pending save still runs', async () => {
	let admitted = true;
	const { files, session } = await open('one\n', () => admitted);
	expect(session.input('mine\n')).toBe(true);
	admitted = false;
	expect(session.input('typed late\n')).toBe(false);
	expect(session.buffer).toBe('mine\n');
	expect(await session.settle()).toBe(true);
	expect(files.at()).toBe('mine\n');
});

// ============================================================================
// Review choices
// ============================================================================

test('take theirs loads exactly the reviewed version, and only when chosen', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.takeTheirs(reviewed)).toBe(true);
	expect(session.buffer).toBe('theirs\n');
	expect(session.saved.source).toBe('theirs\n');
	expect(session.status).toBe('saved');
	expect(files.requests).toEqual([]);
});

test('save mine replaces exactly the reviewed capture', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'mine\n', expected: await versionOf('theirs\n') },
	]);
	expect(files.at()).toBe('mine\n');
	expect(session.status).toBe('saved');
	expect(session.external).toBeUndefined();
});

test('a review that a newer observation replaced can neither save nor load', async () => {
	const { files, session, reviewed } = await conflicted('B\n');
	files.external('C\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).not.toBe(reviewed);
	expect(await session.saveMine(reviewed)).toBe(false);
	expect(session.takeTheirs(reviewed)).toBe(false);
	expect(files.requests).toEqual([]);
	expect(files.at()).toBe('C\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.saved.source).toBe('one\n');
	expect(session.external).toMatchObject({ current: { source: 'C\n' } });
});

test('save mine is refused when the file changed after the review, and nothing it stood on moves', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	// Changed again, and not observed yet: only the write's condition can tell.
	files.external('theirs again\n');
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.at()).toBe('theirs again\n');
	expect(session.buffer).toBe('mine\n');
	// The refused write did not become the base, and the conflict is not cleared.
	expect(session.saved.source).toBe('one\n');
	expect(session.external).not.toBe(reviewed);
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { source: 'theirs again\n' },
	});
	expect(session.status).toBe('conflict');
});

test('save mine that fails leaves the saved base and the reviewed conflict as they were', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	files.next({ kind: 'fail', message: 'disk full' });
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.at()).toBe('theirs\n');
	expect(session.saved.source).toBe('one\n');
	expect(session.external).toBe(reviewed);
	expect(session.failure).toContain('disk full');
	expect(session.buffer).toBe('mine\n');
	// The same review still stands, so the same choice can be made again.
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.at()).toBe('mine\n');
	expect(session.status).toBe('saved');
});

// ============================================================================
// Unconfirmed saves
// ============================================================================

test('a call that throws leaves the save unconfirmed, not lost', async () => {
	const { files, session } = await open('one\n');
	session.input('mine\n');
	files.next({ kind: 'throw', message: 'host unreachable' });
	await session.save();
	expect(session.status).toBe('unconfirmed');
	expect(session.attempt).toMatchObject({
		source: 'mine\n',
		state: 'unconfirmed',
		problem: 'host unreachable',
	});
	expect(session.buffer).toBe('mine\n');
});

test('an unconfirmed save pauses saving, and its retry sends the same text on the same base, not newer typing', async () => {
	const { files, session, base } = await unconfirmed({ landed: false });
	expect(session.status).toBe('unconfirmed');
	expect(session.saved.source).toBe('one\n');

	session.input('A and B\n');
	expect(await session.settle()).toBe(false);
	expect(files.asked).toEqual(['A\n']);

	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'A\n', expected: base },
	]);
	// This send was confirmed, so what it sent is acknowledged.
	expect(files.at()).toBe('A\n');
	expect(session.saved.source).toBe('A\n');
	expect(session.attempt).toBeUndefined();
	expect(session.buffer).toBe('A and B\n');
	expect(session.status).toBe('dirty');
	// The first send arrives at last, and its own condition refuses it.
	expect((await files.land()).error?.name).toBe('Conflict');
	await session.save();
	expect(files.at()).toBe('A and B\n');
});

test('a retry that is refused because the text is already there reconciles on that equality, and newer typing is dirty against it', async () => {
	const { files, session, base } = await unconfirmed({ landed: true });
	expect(files.at()).toBe('A\n');
	session.input('A and B\n');
	await session.retry();
	// Still A on the old base. It was refused; the read after found exactly A.
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A\n',
		expected: base,
	});
	expect(session.saved).toEqual({
		path: PATH,
		source: 'A\n',
		version: await versionOf('A\n'),
	});
	expect(session.attempt).toBeUndefined();
	expect(session.external).toBeUndefined();
	expect(session.buffer).toBe('A and B\n');
	expect(session.status).toBe('dirty');
	await session.save();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B\n',
		expected: await versionOf('A\n'),
	});
	expect(files.at()).toBe('A and B\n');
});

test('reading the old file settles nothing; reading exactly the attempted text reconciles, and starts no save of newer typing', async () => {
	jest.useFakeTimers();
	const { files, session } = await unconfirmed({ landed: false });
	// A read that finds the old file cannot say the save will not land.
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.status).toBe('unconfirmed');
	expect(session.unsettled).toBe(true);
	session.input('A and B\n');
	// It lands afterwards, with no further action.
	expect((await files.land()).error).toBeNull();
	expect(session.observe(await files.observed())).toBe('reconciled');
	expect(session.saved.source).toBe('A\n');
	expect(session.attempt).toBeUndefined();
	expect(session.buffer).toBe('A and B\n');
	expect(session.status).toBe('dirty');
	// No timer was set by the read: the newer typing waits for the person.
	jest.advanceTimersByTime(60_000);
	await Promise.resolve();
	expect(files.asked).toEqual(['A\n']);
	expect(files.at()).toBe('A\n');
	// Their next edit is saved as any edit is, over the reconciled capture.
	session.input('A and B and C\n');
	jest.advanceTimersByTime(500);
	await session.settle();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B and C\n',
		expected: await versionOf('A\n'),
	});
});

test('an unconfirmed save survives other text and the old file coming back, and its retry is still exactly what was sent', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });

	// Another program writes C. It is recorded beside the attempt, not instead of it.
	files.external('C\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toMatchObject({ current: { source: 'C\n' } });
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.status).toBe('unconfirmed');
	// No choice about C is taken while the attempt is out.
	const foreign = session.external;
	expect(foreign !== undefined && session.takeTheirs(foreign)).toBe(false);
	expect(foreign !== undefined && (await session.saveMine(foreign))).toBe(
		false,
	);

	// The old file comes back. That ends the conflict and nothing else.
	files.external('one\n');
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.external).toBeUndefined();
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.saved.source).toBe('one\n');

	session.input('B\n');
	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'A\n', expected: base },
	]);
	expect(files.at()).toBe('A\n');
	expect(session.saved.source).toBe('A\n');
	expect(session.attempt).toBeUndefined();
	expect(session.buffer).toBe('B\n');
	expect(session.status).toBe('dirty');
	// The first send arrives at last and is refused by its own condition.
	expect((await files.land()).error?.name).toBe('Conflict');
});

test('a refused retry keeps the attempt: other text is shown beside it, never written over, and never blessed as the base', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });
	files.external('theirs\n');
	session.input('B\n');
	await session.retry();
	// The retry was A on the old base, refused because the file is not that.
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A\n',
		expected: base,
	});
	expect(files.at()).toBe('theirs\n');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.external).toMatchObject({ current: { source: 'theirs\n' } });
	expect(session.saved.source).toBe('one\n');
	expect(session.buffer).toBe('B\n');
	// A second retry is the same again, not the buffer.
	await session.retry();
	expect(files.asked).toEqual(['A\n', 'A\n', 'A\n']);
	// Nothing else is sent, and no review choice is taken, while it is out.
	expect(await session.settle()).toBe(false);
	const foreign = session.external;
	expect(foreign !== undefined && (await session.saveMine(foreign))).toBe(
		false,
	);
	expect(files.asked).toEqual(['A\n', 'A\n', 'A\n']);
	// The first send cannot land while the file is not what it expected.
	expect((await files.land()).error?.name).toBe('Conflict');
	expect(files.at()).toBe('theirs\n');
	expect(session.status).toBe('unconfirmed');
});

test('a removed or unreadable file does not end an unconfirmed save, and its retry is unchanged', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });
	files.external(undefined);
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toEqual({ kind: 'removed' });
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	// Other bytes, which are not text.
	files.external('\u0000');
	files.corrupt();
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external?.kind).toBe('unreadable');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	await session.retry();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A\n',
		expected: base,
	});
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.saved.source).toBe('one\n');
});

test('a retry is not taken while input is not admitted', async () => {
	let admitted = true;
	const files = disk('one\n');
	const session = createFileSession(
		files.files,
		{ path: PATH, source: 'one\n', version: await versionOf('one\n') },
		{ admits: () => admitted },
	);
	sessions.push(session);
	session.input('A\n');
	files.next({ kind: 'defer' });
	await session.save();
	admitted = false;
	await session.retry();
	expect(files.asked).toEqual(['A\n']);
	expect(session.status).toBe('unconfirmed');
});

// ============================================================================
// A removed file's draft
// ============================================================================

test('a removed file leaves a dirty draft, which is saved back as it was captured', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	expect(reviewed).toEqual({ kind: 'removed' });
	const asked = files.hold();
	const saving = session.saveMine(reviewed);
	await asked;
	session.input('mine and more\n');
	files.release();
	expect(await saving).toBe(true);
	expect(files.requests).toEqual([{ create: PATH, source: 'mine\n' }]);
	expect(files.at()).toBe('mine\n');
	expect(session.saved).toEqual({
		path: PATH,
		source: 'mine\n',
		version: await versionOf('mine\n'),
	});
	expect(session.external).toBeUndefined();
	expect(session.buffer).toBe('mine and more\n');
	expect(session.status).toBe('dirty');
});

test('a path that holds other text sends the draft to another path, as the text first captured', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	files.external('other\n');
	expect(await session.saveMine(reviewed, () => ELSEWHERE)).toBe(true);
	expect(files.requests).toEqual([
		{ create: PATH, source: 'mine\n' },
		{ create: ELSEWHERE, source: 'mine\n' },
	]);
	expect(files.at()).toBe('other\n');
	expect(files.at(ELSEWHERE)).toBe('mine\n');
	expect(session.path).toBe(ELSEWHERE);
	expect(session.status).toBe('saved');
});

test('without another path, a path that holds other text is a conflict to review', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	files.external('other\n');
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.paths()).toEqual([PATH]);
	expect(files.at()).toBe('other\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { source: 'other\n' },
	});
});

test('an unconfirmed save back is retried at its own path, reconciles there, and is never sent elsewhere', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	let alternates = 0;
	const elsewhere = () => {
		alternates += 1;
		return ELSEWHERE;
	};
	files.next({ kind: 'lose' });
	await session.saveMine(reviewed, elsewhere);
	expect(session.status).toBe('unconfirmed');
	expect(session.attempt).toMatchObject({
		path: PATH,
		source: 'mine\n',
		expected: 'absent',
	});
	session.input('mine and more\n');
	await session.retry();
	// The same creation again. Its own earlier write is what occupies the path.
	expect(files.requests).toEqual([
		{ create: PATH, source: 'mine\n' },
		{ create: PATH, source: 'mine\n' },
	]);
	expect(alternates).toBe(0);
	expect(files.paths()).toEqual([PATH]);
	expect(session.path).toBe(PATH);
	expect(session.saved.source).toBe('mine\n');
	expect(session.attempt).toBeUndefined();
	expect(session.buffer).toBe('mine and more\n');
	await session.save();
	expect(files.at()).toBe('mine and more\n');
	expect(files.paths()).toEqual([PATH]);
});

test('an unconfirmed save back whose path then holds other text stays as it was sent, and takes no other path', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	let alternates = 0;
	files.next({ kind: 'defer' });
	await session.saveMine(reviewed, () => {
		alternates += 1;
		return ELSEWHERE;
	});
	files.external('other\n');
	await session.retry();
	expect(alternates).toBe(0);
	expect(files.paths()).toEqual([PATH]);
	expect(files.at()).toBe('other\n');
	expect(session.attempt).toMatchObject({
		path: PATH,
		source: 'mine\n',
		expected: 'absent',
		state: 'unconfirmed',
	});
	expect(session.external).toMatchObject({ current: { source: 'other\n' } });
	// The first creation cannot land while the path is not empty.
	expect((await files.land()).error?.name).toBe('Conflict');
});

// ============================================================================
// Moving and removing
// ============================================================================

test('a move carries the saved capture, and typing during it is saved at the new path', async () => {
	const { files, session } = await open('one\n');
	const version = session.saved.version;
	const asked = files.hold();
	const moving = session.move(ELSEWHERE);
	await asked;
	session.input('typed during the move\n');
	files.release();
	expect((await moving).kind).toBe('done');
	expect(files.requests).toEqual([
		{ move: PATH, to: ELSEWHERE, expected: version },
	]);
	expect(session.path).toBe(ELSEWHERE);
	expect(files.paths()).toEqual([ELSEWHERE]);
	expect(files.at(ELSEWHERE)).toBe('one\n');
	expect(session.buffer).toBe('typed during the move\n');
	await session.save();
	expect(files.at(ELSEWHERE)).toBe('typed during the move\n');
});

test('a move is refused when the file is not the one the session holds, and a clean session follows the file', async () => {
	const { files, session } = await open('one\n');
	files.external('theirs\n');
	expect((await session.move(ELSEWHERE)).kind).toBe('refused');
	expect(files.paths()).toEqual([PATH]);
	expect(session.path).toBe(PATH);
	expect(session.buffer).toBe('theirs\n');
	expect(session.status).toBe('saved');
});

test('a move onto a path that exists is refused and moves nothing', async () => {
	const { files, session } = await open('one\n');
	files.external('other\n', ELSEWHERE);
	const outcome = await session.move(ELSEWHERE);
	expect(outcome).toMatchObject({ kind: 'refused', occupied: ELSEWHERE });
	expect(files.at()).toBe('one\n');
	expect(files.at(ELSEWHERE)).toBe('other\n');
	expect(session.path).toBe(PATH);
});

test('a draft that cannot be saved is neither moved nor removed', async () => {
	const { files, session } = await open('one\n');
	const confirmed = { path: PATH, version: session.saved.version };
	session.input('mine\n');
	files.next({ kind: 'fail', message: 'disk full' });
	expect((await session.move(ELSEWHERE)).kind).toBe('unsettled');
	files.next({ kind: 'fail', message: 'disk full' });
	expect((await session.remove(confirmed)).kind).toBe('unsettled');
	expect(files.paths()).toEqual([PATH]);
	expect(session.buffer).toBe('mine\n');
});

/** Everything a session must refuse while a move or removal is unaccounted for. */
async function expectBlocked(
	files: ReturnType<typeof disk>,
	session: FileSession,
) {
	const requests = [...files.requests];
	const paths = files.paths();
	const path = session.path;
	expect(session.status).toBe('unconfirmed');
	expect(session.unsettled).toBe(true);
	// Typing is kept in the buffer. Nothing is saved, sent again, moved, or removed.
	expect(session.input('typed after\n')).toBe(true);
	await session.retry();
	expect(await session.settle()).toBe(false);
	expect((await session.move('notes/c.md')).kind).toBe('unsettled');
	expect(
		(await session.remove({ path, version: session.saved.version })).kind,
	).toBe('unsettled');
	// No read concludes anything, whatever it finds, and the session is not forgotten.
	expect(session.observe({ kind: 'removed' })).toBe('same');
	expect(session.observe(await files.observed(PATH))).toBe('same');
	expect(session.external).toBeUndefined();
	expect(files.requests).toEqual(requests);
	expect(files.paths()).toEqual(paths);
	expect(session.path).toBe(path);
	expect(session.buffer).toBe('typed after\n');
}

test('a move that could not remove the original is kept as it is: nothing resumes it or cleans it up', async () => {
	const { files, session } = await open('one\n');
	const version = session.saved.version;
	files.next({ kind: 'partial' });
	expect((await session.move(ELSEWHERE)).kind).toBe('partial');
	expect(files.paths()).toEqual([PATH, ELSEWHERE]);
	expect(session.path).toBe(PATH);
	expect(session.pathChange).toMatchObject({
		kind: 'move',
		from: { path: PATH, version },
		to: ELSEWHERE,
		state: 'partial',
	});
	await expectBlocked(files, session);
	expect(files.at(PATH)).toBe('one\n');
	expect(files.at(ELSEWHERE)).toBe('one\n');
});

test('a move whose reply is lost after it landed keeps the session, its path, and what was asked', async () => {
	const { files, session } = await open('one\n');
	const version = session.saved.version;
	files.next({ kind: 'lose' });
	expect((await session.move(ELSEWHERE)).kind).toBe('unconfirmed');
	expect(files.paths()).toEqual([ELSEWHERE]);
	expect(session.path).toBe(PATH);
	expect(session.pathChange).toMatchObject({
		kind: 'move',
		from: { path: PATH, version },
		to: ELSEWHERE,
		state: 'unconfirmed',
	});
	await expectBlocked(files, session);
	expect(files.at(ELSEWHERE)).toBe('one\n');
});

test('a move whose reply is lost before it landed is not sent again, and stays unknown after it lands', async () => {
	const { files, session } = await open('one\n');
	files.next({ kind: 'defer' });
	expect((await session.move(ELSEWHERE)).kind).toBe('unconfirmed');
	expect(files.paths()).toEqual([PATH]);
	await expectBlocked(files, session);
	// The one move that was sent arrives.
	expect((await files.land()).error).toBeNull();
	expect(files.paths()).toEqual([ELSEWHERE]);
	expect(files.at(ELSEWHERE)).toBe('one\n');
	expect(session.path).toBe(PATH);
	expect(session.pathChange?.state).toBe('unconfirmed');
});

test('a removal names the capture that was confirmed, and a file that changed since is kept', async () => {
	const { files, session } = await open('one\n');
	const confirmed = { path: PATH, version: session.saved.version };
	files.external('theirs\n');
	expect((await session.remove(confirmed)).kind).toBe('refused');
	expect(files.requests).toEqual([
		{ remove: PATH, expected: confirmed.version },
	]);
	expect(files.at()).toBe('theirs\n');
	// The clean session follows the file that is there.
	expect(session.buffer).toBe('theirs\n');
	expect(session.pathChange).toBeUndefined();
});

test('a removal that is confirmed leaves nothing outstanding', async () => {
	const { files, session } = await open('one\n');
	const confirmed = { path: PATH, version: session.saved.version };
	expect((await session.remove(confirmed)).kind).toBe('done');
	expect(files.paths()).toEqual([]);
	expect(session.pathChange).toBeUndefined();
});

test('a removal whose reply is lost is kept whether or not the file is gone, and nothing writes the old path again', async () => {
	for (const landed of [true, false]) {
		const { files, session } = await open('one\n');
		const confirmed = { path: PATH, version: session.saved.version };
		files.next({ kind: landed ? 'lose' : 'defer' });
		expect((await session.remove(confirmed)).kind).toBe('unconfirmed');
		expect(files.paths()).toEqual(landed ? [] : [PATH]);
		expect(session.pathChange).toMatchObject({
			kind: 'remove',
			from: confirmed,
			state: 'unconfirmed',
		});
		await expectBlocked(files, session);
	}
});

// ============================================================================
// Acceptance repairs
// ============================================================================

test('a buffer typed back to the saved text does not let other text become the base while a save is unconfirmed', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });
	// The person undoes their typing: the buffer equals what is saved.
	session.input('one\n');
	expect(session.dirty).toBe(false);
	const kept = () => {
		expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
		expect(session.saved).toMatchObject({ source: 'one\n', version: base });
		expect(session.buffer).toBe('one\n');
	};

	// Other text is recorded beside the attempt. It is not adopted.
	files.external('C\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toMatchObject({ current: { source: 'C\n' } });
	kept();

	// A removed file does not make the session forgettable either.
	files.external(undefined);
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toEqual({ kind: 'removed' });
	kept();

	// Nor does a file that is not text.
	files.external('\u0000');
	files.corrupt();
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external?.kind).toBe('unreadable');
	kept();

	// The old file comes back: the conflict is over, and nothing else changed.
	files.external('one\n');
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.external).toBeUndefined();
	kept();

	// The retry is still exactly what was sent.
	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'A\n', expected: base },
	]);
	expect(session.saved.source).toBe('A\n');
	expect(session.attempt).toBeUndefined();
});

test('after a read finds the unconfirmed text, newer typing is saved only when asked: no timer, then an explicit save over that text', async () => {
	jest.useFakeTimers();
	const { files, session } = await unconfirmed({ landed: false });
	session.input('A and B\n');
	expect((await files.land()).error).toBeNull();
	expect(session.observe(await files.observed())).toBe('reconciled');
	expect(session.status).toBe('dirty');
	jest.advanceTimersByTime(60_000);
	await Promise.resolve();
	expect(files.asked).toEqual(['A\n']);
	// The Save control calls this.
	await session.retry();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B\n',
		expected: await versionOf('A\n'),
	});
	expect(files.at()).toBe('A and B\n');
	expect(session.status).toBe('saved');
});

test('a refused retry whose read finds the unconfirmed text sets no timer for newer typing either', async () => {
	jest.useFakeTimers();
	const { files, session } = await unconfirmed({ landed: true });
	session.input('A and B\n');
	await session.retry();
	expect(session.attempt).toBeUndefined();
	expect(session.saved.source).toBe('A\n');
	expect(session.status).toBe('dirty');
	jest.advanceTimersByTime(60_000);
	await Promise.resolve();
	expect(files.asked).toEqual(['A\n', 'A\n']);
	expect(files.at()).toBe('A\n');
	// Closing, like the Save control, publishes it over the reconciled text.
	expect(await session.settle()).toBe(true);
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B\n',
		expected: await versionOf('A\n'),
	});
});

test('a confirmed save still goes on to save what was typed during it', async () => {
	jest.useFakeTimers();
	const { files, session } = await open('one\n');
	session.input('A\n');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	session.input('A and B\n');
	files.release();
	await saving;
	expect(files.asked).toEqual(['A\n']);
	jest.advanceTimersByTime(500);
	await session.settle();
	expect(files.asked).toEqual(['A\n', 'A and B\n']);
});
