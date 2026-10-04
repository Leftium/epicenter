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
 * - What a save sends, keeps, and acknowledges is the text of its bytes: an
 *   unpaired surrogate settles as its replacement and is not sent again
 * - A review choice names one observed version; a newer one invalidates it,
 *   and a refused choice leaves the saved base and the conflict as they were
 * - A failed or unconfirmed save holds saving until the person chooses: no
 *   timer, typing, or settle sends anything. Save again is a new attempt of
 *   what is on screen; keeping the file is the other choice
 * - A read that finds an unconfirmed save's text makes it the file's content
 *   and leaves the save unconfirmed: exact bytes do not say who wrote them
 * - A removed file's draft is saved back exclusively, elsewhere only when its
 *   own path holds other text
 * - A move or removal carries exactly the saved capture; one whose outcome
 *   is unknown, or a move that kept its source, is kept, and nothing more is
 *   changed
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, jest, test } from 'bun:test';
import {
	type CapturedFile,
	type CapturedMoveError,
	type FileCapture,
	FileError,
	hashBytes,
	MoveError,
} from '@epicenter/folder';
import { type Err, Ok, type Result } from 'wellcrafted/result';
import type { FileSession, Observed } from './file-session.svelte.ts';

const { createFileSession } = await import('./file-session.svelte.ts');

const encoder = new TextEncoder();
const PATH = 'notes/a.md';
const ELSEWHERE = 'notes/b.md';

const versionOf = (source: string) => hashBytes(encoder.encode(source));

/** A file holds bytes: what a write stores is the text its bytes decode to. */
const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const textOf = (content: string | Uint8Array) =>
	decoder.decode(
		typeof content === 'string' ? encoder.encode(content) : content,
	);

/** What the next change does instead of answering plainly. */
type Plan =
	| { kind: 'fail'; message: string }
	| { kind: 'throw'; message: string }
	/** The change lands; its reply is lost. */
	| { kind: 'lose' }
	/** The reply is lost first; `land()` publishes the change afterwards. */
	| { kind: 'defer' }
	/** A move creates its destination and cannot remove the original. */
	| { kind: 'sourceNotRemoved' };

/** One change exactly as the session asked for it. */
type Request =
	| { create: string; source: string }
	| { replace: string; source: string; expected: string }
	| { move: string; to: string; expected: string }
	| { remove: string; expected: string };

/** A change's reply. Only a move can also report `MoveError`. */
type Changed<T, E = FileError> = Promise<Result<T, E>>;

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
	let pending: (() => Changed<unknown, FileError | MoveError>) | undefined;
	/** Every change exactly as it was asked for, landed or not. */
	const requests: Request[] = [];

	async function refusal(
		path: string,
		expectedSha256: string,
	): Promise<Result<never, FileError> | undefined> {
		const source = stored.get(path);
		const actualSha256 =
			source === undefined ? undefined : await versionOf(source);
		return actualSha256 === expectedSha256
			? undefined
			: FileError.Conflict({ path, expectedSha256, actualSha256 });
	}

	/** Run one change the way the folder does: wait, then end as planned. */
	async function change<T, E extends FileError | MoveError>(
		path: string,
		publish: () => Changed<T, E>,
	): Changed<T, E | FileError> {
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
		sent: { path: string; source: string } & (
			| { kind: 'create' }
			| { kind: 'replace'; expectedSha256: string }
		),
	): Changed<FileCapture> {
		const { path, source } = sent;
		return change(path, async () => {
			if (sent.kind === 'create') {
				if (stored.has(path)) return FileError.Exists({ path });
			} else {
				const refused = await refusal(path, sent.expectedSha256);
				if (refused) return refused;
			}
			stored.set(path, source);
			notText.delete(path);
			return Ok({ path, sha256: await versionOf(source) });
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
				file: { path, text: source, sha256: await versionOf(source) },
			};
		},
		files: {
			async read(path: string): Promise<Result<CapturedFile, FileError>> {
				const source = stored.get(path);
				if (source === undefined) return FileError.NotFound({ path });
				const bytes = notText.has(path)
					? new Uint8Array([0])
					: encoder.encode(source);
				return Ok({ path, sha256: await hashBytes(bytes), bytes });
			},
			create(path: string, content: string | Uint8Array) {
				const source = textOf(content);
				requests.push({ create: path, source });
				return write({ kind: 'create', path, source });
			},
			replace(file: FileCapture, content: string | Uint8Array) {
				const source = textOf(content);
				requests.push({ replace: file.path, source, expected: file.sha256 });
				return write({
					kind: 'replace',
					path: file.path,
					source,
					expectedSha256: file.sha256,
				});
			},
			move(
				file: FileCapture,
				to: string,
			): Changed<FileCapture, FileError | CapturedMoveError> {
				requests.push({ move: file.path, to, expected: file.sha256 });
				const planned = plan;
				return change<FileCapture, FileError | CapturedMoveError>(
					file.path,
					async () => {
						const source = stored.get(file.path);
						if (source === undefined)
							return FileError.NotFound({ path: file.path });
						const refused =
							(await refusal(file.path, file.sha256)) ??
							(stored.has(to) ? FileError.Exists({ path: to }) : undefined);
						if (refused) return refused;
						stored.set(to, source);
						if (planned?.kind === 'sourceNotRemoved')
							// A file move is guarded, so its kept source names the capture.
							return MoveError.SourceNotRemoved({
								from: file.path,
								to,
								moved: { path: to, sha256: file.sha256 },
								cause: FileError.Io({
									path: file.path,
									operation: 'retire',
									cause: 'the file is in use',
								}).error,
							}) as Err<CapturedMoveError>;
						stored.delete(file.path);
						return Ok({ path: to, sha256: file.sha256 });
					},
				);
			},
			remove(file: FileCapture): Changed<undefined> {
				requests.push({ remove: file.path, expected: file.sha256 });
				return change(file.path, async () => {
					if (!stored.has(file.path))
						return FileError.NotFound({ path: file.path });
					const refused = await refusal(file.path, file.sha256);
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
		{ path: PATH, text: source, sha256: await versionOf(source) },
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
	const base = session.saved.sha256;
	session.input('A\n');
	files.next({ kind: landed ? 'lose' : 'defer' });
	await session.save();
	const sent = {
		kind: 'replace' as const,
		path: PATH,
		source: 'A\n',
		expectedSha256: base,
	};
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
	expect(session.saved.text).toBe('two\n');
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

test('a dirty session keeps its text and review target across repeated external observations', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	expect(session.buffer).toBe('mine\n');
	expect(session.saved.text).toBe('one\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { text: 'theirs\n' },
	});
	expect(session.status).toBe('conflict');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toBe(reviewed);
	// Saving is paused: asking for a save writes nothing.
	await session.save();
	expect(files.requests).toEqual([]);
	expect(files.at()).toBe('theirs\n');
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
		text: 'A\n',
		sha256: await versionOf('A\n'),
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
	expect(session.saved.text).toBe('A\n');
	expect(session.buffer).toBe('A and B\n');
	expect(session.dirty).toBe(true);
	expect(session.attempt).toBeUndefined();
});

test('a save acknowledges the text of the bytes it sent: an unpaired surrogate settles, and the same bytes are not sent again', async () => {
	const { files, session } = await open('one\n');
	// A byte order mark, CRLF, and a surrogate pair are saved as typed. The
	// unpaired surrogate cannot be: its bytes are the replacement character's.
	const typed = '﻿lone \uD800 pair \u{1F600}\r\n';
	const stored = typed.replace('\uD800', '�');
	session.input(typed);
	await session.save();
	expect(files.at()).toBe(stored);
	expect(session.saved).toEqual({
		path: PATH,
		text: stored,
		sha256: await versionOf(stored),
	});
	expect(session.buffer).toBe(stored);
	expect(session.status).toBe('saved');
	expect(await session.settle()).toBe(true);

	// Typed again, it is the saved bytes: nothing is sent, and nothing is dirty.
	session.input(typed);
	expect(await session.settle()).toBe(true);
	expect(session.buffer).toBe(stored);
	expect(files.asked).toEqual([stored]);
});

test('typing during a save whose text encoding changed stays as typed', async () => {
	const { files, session } = await open('one\n');
	session.input('a\uD800');
	const asked = files.hold();
	const saving = session.save();
	await asked;
	expect(session.attempt).toMatchObject({ source: 'a�', state: 'sent' });
	session.input('a\uD800b');
	files.release();
	await saving;
	expect(session.saved.text).toBe('a�');
	// Other bytes than the ones acknowledged: the buffer is left alone.
	expect(session.buffer).toBe('a\uD800b');
	expect(session.dirty).toBe(true);
	await session.save();
	expect(files.asked).toEqual(['a�', 'a�b']);
	expect(session.buffer).toBe('a�b');
	expect(session.status).toBe('saved');
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
	expect(session.saved.text).toBe('one\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { text: 'theirs\n' },
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
	expect(session.saved.text).toBe('mine\n');
	expect(session.buffer).toBe('mine and more\n');
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { text: 'theirs\n' },
	});
});

test('a failed save keeps the draft, holds saving, and is tried again only when asked', async () => {
	jest.useFakeTimers();
	const { files, session } = await open('one\n');
	session.input('mine\n');
	files.next({ kind: 'fail', message: 'disk full' });
	await session.save();
	expect(session.status).toBe('failed');
	expect(session.failure).toContain('disk full');
	expect(session.buffer).toBe('mine\n');
	expect(files.at()).toBe('one\n');
	expect(session.unsettled).toBe(true);
	// Typing, waiting, and settling send nothing.
	session.input('mine and more\n');
	jest.advanceTimersByTime(60_000);
	expect(await session.settle()).toBe(false);
	expect(files.asked).toEqual(['mine\n']);
	// Try again is a new attempt of what is on screen.
	await session.retry();
	expect(session.status).toBe('saved');
	expect(files.asked).toEqual(['mine\n', 'mine and more\n']);
	expect(files.at()).toBe('mine and more\n');
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
	expect(session.saved.text).toBe('theirs\n');
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
	expect(session.saved.text).toBe('one\n');
	expect(session.external).toMatchObject({ current: { text: 'C\n' } });
});

test('save mine is refused when the file changed after the review, and nothing it stood on moves', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	// Changed again, and not observed yet: only the write's condition can tell.
	files.external('theirs again\n');
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.at()).toBe('theirs again\n');
	expect(session.buffer).toBe('mine\n');
	// The refused write did not become the base, and the conflict is not cleared.
	expect(session.saved.text).toBe('one\n');
	expect(session.external).not.toBe(reviewed);
	expect(session.external).toMatchObject({
		kind: 'changed',
		current: { text: 'theirs again\n' },
	});
	expect(session.status).toBe('conflict');
});

test('save mine that fails leaves the saved base and the reviewed conflict as they were', async () => {
	const { files, session, reviewed } = await conflicted('theirs\n');
	files.next({ kind: 'fail', message: 'disk full' });
	expect(await session.saveMine(reviewed)).toBe(true);
	expect(files.at()).toBe('theirs\n');
	expect(session.saved.text).toBe('one\n');
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

test('an unconfirmed save holds saving; Save again is a new attempt of what is on screen, and the late first one is refused', async () => {
	const { files, session, base } = await unconfirmed({ landed: false });
	expect(session.status).toBe('unconfirmed');
	expect(session.saved.text).toBe('one\n');

	// Nothing is sent by itself: not by typing, and not by settling.
	session.input('A and B\n');
	expect(await session.settle()).toBe(false);
	expect(files.asked).toEqual(['A\n']);

	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'A and B\n', expected: base },
	]);
	// This attempt was confirmed: it is what is saved, and nothing is held.
	expect(files.at()).toBe('A and B\n');
	expect(session.saved.text).toBe('A and B\n');
	expect(session.attempt).toBeUndefined();
	expect(session.status).toBe('saved');
	// The first send arrives at last, and its own condition refuses it.
	expect((await files.land()).error?.name).toBe('Conflict');
	expect(files.at()).toBe('A and B\n');
});

test('an unconfirmed save of an unpaired surrogate is kept as the text of its bytes, and the draft stays as typed', async () => {
	const { files, session } = await open('one\n');
	const base = session.saved.sha256;
	session.input('A \uD800\n');
	files.next({ kind: 'defer' });
	await session.save();
	expect(session.attempt).toMatchObject({
		kind: 'replace',
		path: PATH,
		source: 'A �\n',
		expectedSha256: base,
		state: 'unconfirmed',
	});
	// Nothing is known to be saved, so the draft is as it was typed.
	expect(session.buffer).toBe('A \uD800\n');
	expect(await session.settle()).toBe(false);

	await session.retry();
	const sent = { replace: PATH, source: 'A �\n', expected: base };
	expect(files.requests).toEqual([sent, sent]);
	expect(session.attempt).toBeUndefined();
	expect(session.saved.text).toBe('A �\n');
	expect(session.buffer).toBe('A �\n');
	expect(session.status).toBe('saved');
	expect((await files.land()).error?.name).toBe('Conflict');
});

test('a refused Save again that finds the unconfirmed text makes it the file’s content, and the save stays not confirmed', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: true });
	expect(files.at()).toBe('A\n');
	session.input('A and B\n');
	await session.retry();
	// The new attempt was on the old base, so it was refused and wrote nothing.
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B\n',
		expected: base,
	});
	// The read after it found exactly A. That is what the file holds; it does
	// not show which save wrote it.
	expect(session.saved).toEqual({
		path: PATH,
		text: 'A\n',
		sha256: await versionOf('A\n'),
	});
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.external).toBeUndefined();
	expect(session.failure).toBeUndefined();
	expect(session.buffer).toBe('A and B\n');
	expect(session.status).toBe('unconfirmed');
	// Nothing more is sent by itself.
	expect(await session.settle()).toBe(false);
	expect(files.asked).toEqual(['A\n', 'A and B\n']);
	// Save again, on what the file holds now.
	await session.retry();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B\n',
		expected: await versionOf('A\n'),
	});
	expect(files.at()).toBe('A and B\n');
	expect(session.status).toBe('saved');
});

test('reading the old file settles nothing; reading exactly the attempted text is the file’s content, and the save stays unconfirmed', async () => {
	jest.useFakeTimers();
	const { files, session, sent } = await unconfirmed({ landed: false });
	// A read that finds the old file cannot say the save will not land.
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.status).toBe('unconfirmed');
	expect(session.unsettled).toBe(true);
	session.input('A and B\n');
	// It lands afterwards, with no further action.
	expect((await files.land()).error).toBeNull();
	expect(session.observe(await files.observed())).toBe('agreed');
	expect(session.saved.text).toBe('A\n');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.buffer).toBe('A and B\n');
	expect(session.status).toBe('unconfirmed');
	// No timer was set by the read, and typing sets none either.
	jest.advanceTimersByTime(60_000);
	session.input('A and B and C\n');
	jest.advanceTimersByTime(60_000);
	await Promise.resolve();
	expect(files.asked).toEqual(['A\n']);
	expect(files.at()).toBe('A\n');
	// The person saves: a new attempt over the text the file holds.
	await session.retry();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'A and B and C\n',
		expected: await versionOf('A\n'),
	});
	expect(session.status).toBe('saved');
});

test('an unconfirmed save survives other text and the old file coming back, and Save again sends what is on screen', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });

	// Another program writes C. It is recorded beside the attempt, not instead of it.
	files.external('C\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toMatchObject({ current: { text: 'C\n' } });
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.status).toBe('unconfirmed');

	// The old file comes back. That ends the conflict and nothing else.
	files.external('one\n');
	expect(session.observe(await files.observed())).toBe('same');
	expect(session.external).toBeUndefined();
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.saved.text).toBe('one\n');

	session.input('B\n');
	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'B\n', expected: base },
	]);
	expect(files.at()).toBe('B\n');
	expect(session.attempt).toBeUndefined();
	expect(session.status).toBe('saved');
	// The first send arrives at last and is refused by its own condition.
	expect((await files.land()).error?.name).toBe('Conflict');
});

test('a refused Save again keeps the earlier attempt on record: other text is shown beside it, never written over, until the person chooses', async () => {
	const { files, session, base, sent } = await unconfirmed({ landed: false });
	files.external('theirs\n');
	session.input('B\n');
	await session.retry();
	// The new attempt was on the old base, refused because the file is not that.
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'B\n',
		expected: base,
	});
	expect(files.at()).toBe('theirs\n');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.external).toMatchObject({ current: { text: 'theirs\n' } });
	expect(session.saved.text).toBe('one\n');
	expect(session.buffer).toBe('B\n');
	// Nothing is sent by itself while it is held.
	expect(await session.settle()).toBe(false);
	expect(files.asked).toEqual(['A\n', 'B\n']);
	// Keeping the file needs the other text reviewed first.
	expect(session.keepFile()).toBe(false);
	const foreign = session.external;
	if (foreign === undefined) throw new Error('No conflict was recorded');
	// Taking the reviewed file is the person's choice: it ends the hold.
	expect(session.takeTheirs(foreign)).toBe(true);
	expect(session.buffer).toBe('theirs\n');
	expect(session.attempt).toBeUndefined();
	expect(session.status).toBe('saved');
	// The first send cannot land while the file is not what it expected.
	expect((await files.land()).error?.name).toBe('Conflict');
	expect(files.at()).toBe('theirs\n');
});

test('a removed or unreadable file does not end an unconfirmed save', async () => {
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
	expect(session.saved.text).toBe('one\n');
});

test('a retry is not taken while input is not admitted', async () => {
	let admitted = true;
	const files = disk('one\n');
	const session = createFileSession(
		files.files,
		{ path: PATH, text: 'one\n', sha256: await versionOf('one\n') },
		{ admits: () => admitted },
	);
	sessions.push(session);
	session.input('A\n');
	files.next({ kind: 'defer' });
	await session.save();
	admitted = false;
	await session.retry();
	expect(session.keepFile()).toBe(false);
	expect(files.asked).toEqual(['A\n']);
	expect(session.status).toBe('unconfirmed');
});

test('keeping the file ends the hold on an unconfirmed save without saying it landed, and sends nothing', async () => {
	const { files, session, sent } = await unconfirmed({ landed: true });
	session.input('A and B\n');
	expect(session.observe(await files.observed())).toBe('agreed');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	// The person keeps the file as it was last read; their draft goes.
	expect(session.keepFile()).toBe(true);
	expect(session.buffer).toBe('A\n');
	expect(session.attempt).toBeUndefined();
	expect(session.status).toBe('saved');
	expect(files.asked).toEqual(['A\n']);
	// Saving by itself starts again with the next edit.
	session.input('A and C\n');
	expect(await session.settle()).toBe(true);
	expect(files.at()).toBe('A and C\n');
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
		text: 'mine\n',
		sha256: await versionOf('mine\n'),
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
		current: { text: 'other\n' },
	});
});

test('an unconfirmed save back is saved again at its own path only, and never sent elsewhere', async () => {
	const { files, session, reviewed } = await conflicted(undefined);
	let alternates = 0;
	const elsewhere = () => {
		alternates += 1;
		return ELSEWHERE;
	};
	files.next({ kind: 'lose' });
	await session.saveMine(reviewed, elsewhere);
	expect(session.status).toBe('unconfirmed');
	const sent = { kind: 'create' as const, path: PATH, source: 'mine\n' };
	expect(session.attempt).toMatchObject(sent);
	session.input('mine and more\n');
	await session.retry();
	// A new creation of what is on screen, at the same path. The earlier one
	// is what occupies it, so this one is refused.
	expect(files.requests).toEqual([
		{ create: PATH, source: 'mine\n' },
		{ create: PATH, source: 'mine and more\n' },
	]);
	expect(alternates).toBe(0);
	expect(files.paths()).toEqual([PATH]);
	expect(session.path).toBe(PATH);
	// The file holds the earlier text. Which write put it there is not known.
	expect(session.saved.text).toBe('mine\n');
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect(session.buffer).toBe('mine and more\n');
	await session.save();
	expect(files.at()).toBe('mine\n');
	// Save again, over the text the file holds.
	await session.retry();
	expect(files.at()).toBe('mine and more\n');
	expect(files.paths()).toEqual([PATH]);
	expect(session.status).toBe('saved');
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
		kind: 'create' as const,
		path: PATH,
		source: 'mine\n',
		state: 'unconfirmed',
	});
	expect(session.external).toMatchObject({ current: { text: 'other\n' } });
	// The first creation cannot land while the path is not empty.
	expect((await files.land()).error?.name).toBe('Exists');
});

// ============================================================================
// Moving and removing
// ============================================================================

test('a move carries the saved capture, and typing during it is saved at the new path', async () => {
	const { files, session } = await open('one\n');
	const sha256 = session.saved.sha256;
	const asked = files.hold();
	const moving = session.move(ELSEWHERE);
	await asked;
	session.input('typed during the move\n');
	files.release();
	expect((await moving).kind).toBe('done');
	expect(files.requests).toEqual([
		{ move: PATH, to: ELSEWHERE, expected: sha256 },
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
	const confirmed = { path: PATH, sha256: session.saved.sha256 };
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
		(await session.remove({ path, sha256: session.saved.sha256 })).kind,
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
	const sha256 = session.saved.sha256;
	files.next({ kind: 'sourceNotRemoved' });
	expect(await session.move(ELSEWHERE)).toMatchObject({
		kind: 'sourceNotRemoved',
		from: PATH,
		to: ELSEWHERE,
		moved: { path: ELSEWHERE, sha256 },
	});
	expect(files.paths()).toEqual([PATH, ELSEWHERE]);
	expect(session.path).toBe(PATH);
	expect(session.pathChange).toMatchObject({
		kind: 'move',
		from: { path: PATH, sha256 },
		to: ELSEWHERE,
		state: 'sourceNotRemoved',
	});
	await expectBlocked(files, session);
	expect(files.at(PATH)).toBe('one\n');
	expect(files.at(ELSEWHERE)).toBe('one\n');
	// The person stops tracking it. Nothing is concluded and nothing is sent;
	// the draft is held until they choose.
	const requests = files.requests.length;
	expect(session.detach()).toBe(true);
	expect(session.pathChange).toBeUndefined();
	expect(session.detached).toMatchObject({
		kind: 'move',
		to: ELSEWHERE,
		state: 'sourceNotRemoved',
	});
	expect(session.status).toBe('failed');
	expect(session.buffer).toBe('typed after\n');
	expect(await session.settle()).toBe(false);
	expect(files.requests).toHaveLength(requests);
	// Saving is theirs to ask for, and is conditional on the text last read.
	await session.retry();
	expect(files.requests.at(-1)).toEqual({
		replace: PATH,
		source: 'typed after\n',
		expected: sha256,
	});
	expect(files.at(PATH)).toBe('typed after\n');
	expect(files.at(ELSEWHERE)).toBe('one\n');
	expect(session.detached).toBeUndefined();
});

test('a move whose reply is lost after it landed keeps the session, its path, and what was asked', async () => {
	const { files, session } = await open('one\n');
	const sha256 = session.saved.sha256;
	files.next({ kind: 'lose' });
	expect((await session.move(ELSEWHERE)).kind).toBe('unconfirmed');
	expect(files.paths()).toEqual([ELSEWHERE]);
	expect(session.path).toBe(PATH);
	expect(session.pathChange).toMatchObject({
		kind: 'move',
		from: { path: PATH, sha256 },
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
	const confirmed = { path: PATH, sha256: session.saved.sha256 };
	files.external('theirs\n');
	expect((await session.remove(confirmed)).kind).toBe('refused');
	expect(files.requests).toEqual([
		{ remove: PATH, expected: confirmed.sha256 },
	]);
	expect(files.at()).toBe('theirs\n');
	// The clean session follows the file that is there.
	expect(session.buffer).toBe('theirs\n');
	expect(session.pathChange).toBeUndefined();
});

test('a removal that is confirmed leaves nothing outstanding', async () => {
	const { files, session } = await open('one\n');
	const confirmed = { path: PATH, sha256: session.saved.sha256 };
	expect((await session.remove(confirmed)).kind).toBe('done');
	expect(files.paths()).toEqual([]);
	expect(session.pathChange).toBeUndefined();
});

test('a removal whose reply is lost is kept whether or not the file is gone, and nothing writes the old path again', async () => {
	for (const landed of [true, false]) {
		const { files, session } = await open('one\n');
		const confirmed = { path: PATH, sha256: session.saved.sha256 };
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
		expect(session.saved).toMatchObject({ text: 'one\n', sha256: base });
		expect(session.buffer).toBe('one\n');
	};

	// Other text is recorded beside the attempt. It is not adopted.
	files.external('C\n');
	expect(session.observe(await files.observed())).toBe('conflict');
	expect(session.external).toMatchObject({ current: { text: 'C\n' } });
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

	// Save again sends what is on screen, the old text, as a new attempt.
	await session.retry();
	expect(files.requests).toEqual([
		{ replace: PATH, source: 'A\n', expected: base },
		{ replace: PATH, source: 'one\n', expected: base },
	]);
	expect(session.saved.text).toBe('one\n');
	// It left the file as the bytes the first send was conditional on, so the
	// first send can still land, and it stays on record.
	expect(session.attempt).toMatchObject({ ...sent, state: 'unconfirmed' });
	expect((await files.land()).error).toBeNull();
	// When a read finds it, that is the file's content; the draft is kept.
	expect(session.observe(await files.observed())).toBe('agreed');
	expect(session.saved.text).toBe('A\n');
	expect(session.buffer).toBe('one\n');
	expect(session.status).toBe('unconfirmed');
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
