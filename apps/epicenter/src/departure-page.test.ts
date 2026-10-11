/**
 * Departure Page Client Tests
 *
 * Drives the one page client (`createDeparture`, `openForDeparture`) over a
 * stand-in for the host's side of the wire, with a recorded owner that
 * notes what it was asked to do. The host stand-in keeps the wire's rules:
 * versions rise, stale answers change nothing, `cancel` ends the round. It
 * does not run the native dialog, show or hide windows, or quit. What an
 * owner fences and settles is tested with each app's owner.
 *
 * Key behaviors:
 * - Listening is registered before the first status read; nothing opens
 *   until a status is known, and a failed registration or read is retried
 *   without listening twice
 * - Statuses apply in version order; only a newer `idle` lifts the fence
 * - The fence goes up before any await, and an owner still opening is
 *   fenced as it attaches
 * - A page holding nothing answers `ready` at once; otherwise it answers
 *   `asking`, settles, and answers `ready` or asks the person
 * - Each prompt has an identity; a choice counts only for its own prompt
 * - A lost answer is re-sent for its round, once per read, and never lifts
 *   the fence; a repeated Quit keeps the round's choice
 * - `granted`, `leaving`, and a `discarded` vote stay fenced and answer
 *   nothing more
 * - After destroy, nothing is read or answered
 */
import './svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type {
	Departure,
	DepartureParticipant,
} from './departure-page.svelte.ts';
import { createFakeHost } from './departure-page.test-support.js';

const { createDeparture, openForDeparture } = await import(
	'./departure-page.svelte.ts'
);

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

function track(departure: Departure) {
	cleanup.push(() => departure.destroy());
	return departure;
}

/**
 * An owner that records what it was asked to do. `holds` is whether it
 * holds anything unsaved; `settled(count)` finishes the current settle.
 */
function recordedOwner(holds = true) {
	const events: string[] = [];
	let settling = Promise.withResolvers<number>();
	let fenced = false;
	const participant: DepartureParticipant = {
		get holdsUnsaved() {
			return holds;
		},
		fence() {
			fenced = true;
			events.push('fence');
		},
		settle() {
			events.push('settle');
			return settling.promise;
		},
		resume() {
			fenced = false;
			events.push('resume');
		},
	};
	return {
		participant,
		events,
		get fenced() {
			return fenced;
		},
		/** Finish the current settle with `count` things still held. */
		settled(count: number) {
			settling.resolve(count);
			settling = Promise.withResolvers<number>();
		},
		/** Fail the current settle. */
		fail(cause: Error) {
			settling.reject(cause);
			settling = Promise.withResolvers<number>();
		},
	};
}

/** Let reads, answers, and settles run. */
async function settle() {
	for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

const answersOf = (host: ReturnType<typeof createFakeHost>) =>
	host.answers.map((answer) => answer.answer);

/** The identity of the prompt shown now, as its controls carry it. */
function shownPrompt(departure: Departure): number {
	const notice = departure.notice;
	if (notice?.stage !== 'choose')
		throw new Error(`Expected a prompt, got ${notice?.stage}`);
	return notice.id;
}

/** A started departure with an attached owner, idle. */
async function started(holds = true) {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	await departure.start();
	const owner = recordedOwner(holds);
	departure.attach(owner.participant);
	return { host, departure, owner };
}

/** A started departure whose owner asks the person: settling leaves `held` things. */
async function prompted(held = 1) {
	const page = await started();
	page.host.begin('quit');
	page.host.nudge();
	await settle();
	page.owner.settled(held);
	await settle();
	shownPrompt(page.departure);
	return page;
}

/**
 * An opener for `openForDeparture` that counts its calls and can be held,
 * so a test sees whether, and when, the page opened anything.
 */
function ownerOpener(holds = false) {
	let gate: Promise<void> | undefined;
	const opener = {
		calls: 0,
		/** Hold the next open until the returned function runs. */
		hold() {
			const held = Promise.withResolvers<void>();
			gate = held.promise;
			return held.resolve;
		},
		open: async () => {
			opener.calls += 1;
			await gate;
			return recordedOwner(holds);
		},
	};
	return opener;
}

/** Open the page's owner as a page does. */
function openPage(
	departure: Departure,
	opener: ReturnType<typeof ownerOpener>,
) {
	const opening = openForDeparture(
		departure,
		opener.open,
		(owner) => owner.participant,
	);
	// A page that leaves first rejects; the test checks that itself.
	opening.catch(() => {});
	return opening;
}

// ============================================================================
// Starting: listen first, open only once a status is known
// ============================================================================

test('listening is registered before the first status read, and a round that arrives while the owner opens is answered once it attaches, fenced as it attaches', async () => {
	const host = createFakeHost();
	const release = host.holdListening();
	const departure = track(createDeparture(host.port));
	const starting = departure.start();
	await settle();
	expect(host.calls).toEqual(['listen']);
	expect(departure.known).toBe(false);
	release();
	await starting;
	expect(host.calls).toEqual(['listen', 'listening', 'status']);
	expect(departure.known).toBe(true);
	expect(departure.fenced).toBe(false);

	// A quit begins while the owner is still opening: nothing is answered yet.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.answers).toEqual([]);
	expect(departure.notice).toEqual({ stage: 'saving', intent: 'quit' });
	expect(departure.fenced).toBe(true);

	const owner = recordedOwner(false);
	departure.attach(owner.participant);
	// Fenced as it attaches, before anything is awaited.
	expect(owner.events).toEqual(['fence']);
	await settle();
	// It holds nothing, so it answers ready, and stays fenced.
	expect(answersOf(host)).toEqual(['ready']);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'quit' });
	expect(owner.fenced).toBe(true);

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(owner.events).toEqual(['fence', 'resume']);
	expect(departure.fenced).toBe(false);
	expect(departure.notice).toBeUndefined();
});

test('a listener that could not register leaves the page unopened; starting again registers once and opens it', async () => {
	const host = createFakeHost();
	host.refuseListening(1);
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	await departure.start();
	expect(departure.problem).toContain('could not listen');
	await settle();
	expect(opener.calls).toBe(0);
	expect(host.calls).toEqual(['listen']);

	await departure.start();
	const owner = await opening;
	expect(departure.problem).toBeUndefined();
	expect(opener.calls).toBe(1);
	expect(host.calls).toEqual(['listen', 'listen', 'listening', 'status']);
	expect(owner.fenced).toBe(false);
	// One listener: a nudge reads once.
	host.nudge();
	await settle();
	expect(host.calls.filter((call) => call === 'status')).toHaveLength(2);
});

test('a first status read that failed or was malformed is not idle: nothing opens until a read succeeds, and starting again does not listen again', async () => {
	const host = createFakeHost();
	host.faultStatus('reject', 'malformed');
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	await departure.start();
	expect(departure.problem).toContain('status read failed');
	await settle();
	expect(opener.calls).toBe(0);
	await departure.start();
	expect(departure.problem).toBeDefined();
	expect(departure.known).toBe(false);
	await settle();
	expect(opener.calls).toBe(0);

	await departure.start();
	await opening;
	expect(departure.problem).toBeUndefined();
	expect(opener.calls).toBe(1);
	expect(host.calls.filter((call) => call === 'listen')).toHaveLength(1);
	expect(host.calls.filter((call) => call === 'status')).toHaveLength(3);
});

test('after a failed first read, a nudge for a running round opens the owner fenced, and it is answered for', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	await departure.start();
	expect(opener.calls).toBe(0);

	host.begin('quit');
	host.nudge();
	const owner = await opening;
	// Fenced from the moment it was attached; it never took input.
	expect(owner.events).toEqual(['fence']);
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
});

test('after a failed first read, a focus gain reads again and opens the owner', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	await departure.start();
	await settle();
	expect(opener.calls).toBe(0);
	host.focus();
	const owner = await opening;
	expect(owner.events).toEqual([]);
});

test('a round that begins while the owner opens fences it as it attaches, before anything else', async () => {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const release = opener.hold();
	const opening = openPage(departure, opener);
	await departure.start();
	await settle();
	expect(opener.calls).toBe(1);
	host.begin('restart');
	host.nudge();
	await settle();
	expect(host.answers).toEqual([]);
	release();
	const owner = await opening;
	expect(owner.events).toEqual(['fence']);
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
});

test('an owner that fails to open is attached as none: a departure is answered ready', async () => {
	const host = createFakeHost();
	const departure = track(createDeparture(host.port));
	await departure.start();
	const opening = openForDeparture(
		departure,
		() => Promise.reject(new Error('The folder could not open')),
		() => undefined,
	);
	await expect(opening).rejects.toThrow('could not open');
	host.begin('restart');
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
	expect(departure.fenced).toBe(true);
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(departure.notice).toBeUndefined();
	expect(departure.fenced).toBe(false);
	// A later round is answered the same way.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['ready', 'ready']);
});

test('without a departure, a page opens at once', async () => {
	const opener = ownerOpener();
	const owner = await openForDeparture(
		undefined,
		opener.open,
		(opened) => opened.participant,
	);
	expect(opener.calls).toBe(1);
	expect(owner.events).toEqual([]);
});

test('a nudge during a listener registration that then fails reads nothing and opens nothing; starting again recovers', async () => {
	const host = createFakeHost();
	const releaseFocus = host.holdFocusRegistration();
	host.refuseListening(1);
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	const starting = departure.start();
	await settle();
	// The change listener is registered; the rest is not done.
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.calls).toEqual(['listen']);
	releaseFocus();
	await starting;
	expect(departure.problem).toContain('could not listen');
	host.nudge();
	await settle();
	expect(host.calls.filter((call) => call === 'status')).toEqual([]);
	expect(opener.calls).toBe(0);

	await departure.start();
	const owner = await opening;
	expect(opener.calls).toBe(1);
	expect(owner.events).toEqual(['fence']);
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
});

test('a nudge during a registration that then succeeds reads nothing itself; the read after registering covers it', async () => {
	const host = createFakeHost();
	const releaseFocus = host.holdFocusRegistration();
	const departure = track(createDeparture(host.port));
	const starting = departure.start();
	await settle();
	host.nudge();
	await settle();
	expect(host.calls).toEqual(['listen']);
	releaseFocus();
	await starting;
	expect(host.calls).toEqual(['listen', 'listening', 'status']);
});

// ============================================================================
// Version order and the fence
// ============================================================================

test('statuses apply in version order: an older idle read after a newer round lifts nothing, and a newer idle does', async () => {
	const { host, departure, owner } = await started(false);
	host.begin();
	const round = host.status.version;
	host.nudge();
	await settle();
	expect(owner.fenced).toBe(true);

	// A read that answers with an older version: ignored.
	host.set({ phase: 'idle' }, round - 1);
	host.nudge();
	await settle();
	expect(owner.fenced).toBe(true);
	expect(departure.fenced).toBe(true);

	host.set({ phase: 'idle' }, round + 10);
	host.nudge();
	await settle();
	expect(owner.fenced).toBe(false);
	expect(departure.fenced).toBe(false);
});

test('an idle read that began before a newer round, and finishes after the reply that carried it, lifts nothing', async () => {
	const { host, departure, owner } = await prompted();
	// The round ends, and a read of that idle is held on its way.
	host.set({ phase: 'idle' });
	const olderIdle = host.status.version;
	const releaseRead = host.holdRead();
	host.nudge();
	// A restart begins; the reply to this page's late choice carries it.
	host.begin('restart');
	departure.keepWorking(shownPrompt(departure));
	await settle();
	expect(departure.notice).toEqual({ stage: 'saving', intent: 'restart' });
	releaseRead();
	await settle();
	expect(olderIdle).toBeLessThan(host.status.version);
	expect(departure.fenced).toBe(true);
	expect(owner.events).toEqual(['fence', 'settle', 'settle']);

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(owner.events.at(-1)).toBe('resume');
});

test('the fence goes up as the round is read, before the owner is asked to settle', async () => {
	const { host, owner } = await started();
	host.begin('quit');
	host.nudge();
	await settle();
	expect(owner.events).toEqual(['fence', 'settle']);
	expect(answersOf(host)).toEqual(['asking']);
});

// ============================================================================
// Answering
// ============================================================================

test('a page holding something answers asking, settles, and answers ready when nothing is left, staying fenced', async () => {
	const { host, departure, owner } = await started();
	host.begin('restart');
	host.nudge();
	await settle();
	expect(departure.notice).toEqual({ stage: 'saving', intent: 'restart' });
	owner.settled(0);
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'ready']);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'restart' });
	expect(owner.fenced).toBe(true);
});

test("what is left after settling is the person's choice; Keep working cancels the round and gives the owner back", async () => {
	const { host, departure, owner } = await prompted(2);
	expect(departure.notice).toEqual({
		stage: 'choose',
		id: expect.any(Number),
		intent: 'quit',
		held: 2,
	});
	departure.keepWorking(shownPrompt(departure));
	expect(departure.notice).toEqual({ stage: 'keeping', intent: 'quit' });
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'cancel']);
	expect(host.status.phase).toBe('idle');
	expect(owner.events).toEqual(['fence', 'settle', 'resume']);
	expect(departure.notice).toBeUndefined();
});

test('leaving anyway is a ready vote only: the owner stays fenced until an idle gives it back', async () => {
	const { host, departure, owner } = await prompted();
	departure.leaveAnyway(shownPrompt(departure));
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'ready']);
	expect(departure.notice).toEqual({ stage: 'ready', intent: 'quit' });
	expect(owner.events).toEqual(['fence', 'settle']);

	// Another window chose Keep working: the round ends.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(owner.events).toEqual(['fence', 'settle', 'resume']);
});

test('a settle that fails counts as something held: the person chooses', async () => {
	const { host, departure, owner } = await started();
	host.begin('quit');
	host.nudge();
	await settle();
	owner.fail(new Error('The save could not finish'));
	await settle();
	expect(departure.notice).toMatchObject({ stage: 'choose', held: 1 });
	expect(answersOf(host)).toEqual(['asking']);
});

test('the same round asked again while settling re-sends asking, with no second prompt', async () => {
	const { host, departure, owner } = await started();
	host.begin('quit');
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['asking']);

	// The person quits again: the host shows the round with no vote.
	host.set({ phase: 'collecting', vote: 'none' });
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'asking']);
	expect(departure.notice?.stage).toBe('saving');
	expect(owner.events).toEqual(['fence', 'settle']);

	owner.settled(1);
	await settle();
	const prompt = departure.notice;
	expect(prompt?.stage).toBe('choose');
	// Asked again once the prompt is up: asking again, the same prompt.
	host.set({ phase: 'collecting', vote: 'none' });
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'asking', 'asking']);
	expect(departure.notice).toBe(prompt);
	expect(owner.events).toEqual(['fence', 'settle']);
});

test('a newer round that arrives while the person chooses is handled from the start, fenced throughout', async () => {
	const { host, departure, owner } = await prompted();
	// The round ends and a restart round begins before this page reads idle.
	host.begin('restart');
	host.nudge();
	await settle();
	expect(departure.notice).toEqual({ stage: 'saving', intent: 'restart' });
	owner.settled(1);
	await settle();
	expect(departure.notice).toMatchObject({
		stage: 'choose',
		intent: 'restart',
	});
	// Never given back between the rounds.
	expect(owner.events).toEqual(['fence', 'settle', 'settle']);
	expect(host.answers.map((answer) => [answer.round, answer.answer])).toEqual([
		[1, 'asking'],
		[2, 'asking'],
	]);
	// The person's choice answers the newer round only.
	departure.keepWorking(shownPrompt(departure));
	await settle();
	expect(host.answers.at(-1)).toMatchObject({ round: 2, answer: 'cancel' });
	expect(owner.events.at(-1)).toBe('resume');
});

test("a choice from an earlier round's prompt answers nothing in a later round", async () => {
	const { host, departure, owner } = await prompted();
	const first = shownPrompt(departure);
	// Another window ends the quit; a restart begins.
	host.set({ phase: 'idle' });
	host.begin('restart');
	host.nudge();
	await settle();
	owner.settled(1);
	await settle();
	expect(shownPrompt(departure)).not.toBe(first);
	departure.leaveAnyway(first);
	departure.keepWorking(first);
	await settle();
	expect(host.answers.map((answer) => [answer.round, answer.answer])).toEqual([
		[1, 'asking'],
		[2, 'asking'],
	]);
	expect(departure.notice?.stage).toBe('choose');
	expect(owner.fenced).toBe(true);
});

// ============================================================================
// Ending: granted, leaving, discarded
// ============================================================================

test('granted, leaving, and a discarded vote stay fenced and dismiss the prompt; focus reads again and nothing is answered', async () => {
	for (const next of [
		{ phase: 'granted' },
		{ phase: 'leaving' },
		{ phase: 'collecting', vote: 'discarded' },
	] as const) {
		const { host, departure, owner } = await prompted();
		host.set(next);
		host.nudge();
		await settle();
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(departure.fenced).toBe(true);
		// Focus while fenced reads again; still fenced, nothing more answered.
		const reads = host.calls.filter((call) => call === 'status').length;
		host.focus();
		await settle();
		expect(host.calls.filter((call) => call === 'status').length).toBe(
			reads + 1,
		);
		expect(answersOf(host)).toEqual(['asking']);
		expect(owner.events).toEqual(['fence', 'settle']);
	}
});

for (const ending of [
	{ phase: 'granted' },
	{ phase: 'collecting', vote: 'discarded' },
] as const)
	test(`${ending.phase === 'granted' ? 'granted' : 'a discarded vote'} during a held settle ends the handling: the settle finishes, and nothing more is answered or prompted`, async () => {
		const { host, departure, owner } = await started();
		host.begin('quit');
		host.nudge();
		await settle();
		expect(answersOf(host)).toEqual(['asking']);

		host.set(ending);
		host.nudge();
		await settle();
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		owner.settled(1);
		await settle();
		expect(answersOf(host)).toEqual(['asking']);
		expect(departure.notice).toEqual({ stage: 'leaving', intent: 'quit' });
		expect(owner.fenced).toBe(true);
	});

test('a granted round re-sends nothing, whatever reads follow', async () => {
	const { host, owner } = await started(false);
	host.begin('quit');
	host.nudge();
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
	host.set({ phase: 'granted', vote: 'none' });
	host.nudge();
	host.focus();
	await settle();
	expect(answersOf(host)).toEqual(['ready']);
	expect(owner.fenced).toBe(true);
});

// ============================================================================
// Lost answers
// ============================================================================

test('a lost answer lifts nothing, and the next read re-sends it', async () => {
	const { host, departure, owner } = await started(false);
	host.loseAnswers(1);
	host.begin('quit');
	host.nudge();
	await settle();
	// The ready answer was lost; the page read again and sent it again.
	expect(answersOf(host)).toEqual(['ready', 'ready']);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	expect(departure.problem).toBeUndefined();
	expect(owner.fenced).toBe(true);
});

test('a ready answer lost before the host recorded it, with asking recorded, is sent again; a repeated Quit re-sends ready, not asking', async () => {
	const { host, owner } = await started();
	host.begin('quit');
	host.nudge();
	await settle();
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'asking' });
	host.loseAnswers(1);
	owner.settled(0);
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'ready', 'ready']);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	host.set({ phase: 'collecting', vote: 'none' });
	host.nudge();
	await settle();
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(owner.fenced).toBe(true);
});

test('Keep working whose answer was lost is sent again, and a repeated Quit does not turn it back into asking', async () => {
	const { host, departure, owner } = await prompted();
	host.loseAnswers(1);
	departure.keepWorking(shownPrompt(departure));
	await settle();
	// Lost, then read again with asking still recorded: cancel again.
	expect(answersOf(host)).toEqual(['asking', 'cancel', 'cancel']);
	expect(host.status.phase).toBe('idle');
	expect(owner.events.at(-1)).toBe('resume');
});

test('a lost answer is shown as a problem and stays fenced until a read sends it again', async () => {
	const { host, departure, owner } = await prompted();
	host.loseAnswers(2);
	departure.keepWorking(shownPrompt(departure));
	await settle();
	// The answer and its one recovery resend were both lost.
	expect(answersOf(host)).toEqual(['asking', 'cancel', 'cancel']);
	expect(departure.problem).toContain('lost');
	expect(departure.fenced).toBe(true);
	expect(owner.events).toEqual(['fence', 'settle']);

	// Focus while fenced reads again and sends the same answer for this round.
	host.focus();
	await settle();
	expect(answersOf(host)).toEqual(['asking', 'cancel', 'cancel', 'cancel']);
	expect(departure.problem).toBeUndefined();
	expect(departure.fenced).toBe(false);
	expect(owner.events).toEqual(['fence', 'settle', 'resume']);
});

test('answers that keep failing while reads succeed stop after one recovery read, and each nudge or focus tries again once', async () => {
	const { host, owner } = await started(false);
	host.loseAnswers(1000);
	host.begin('quit');
	host.nudge();
	await settle();
	await Bun.sleep(30);
	await settle();
	// The answer, then one recovery read and its resend; then nothing.
	expect(answersOf(host)).toEqual(['ready', 'ready']);
	const reads = host.calls.filter((call) => call === 'status').length;
	await Bun.sleep(30);
	await settle();
	expect(host.answers).toHaveLength(2);
	expect(host.calls.filter((call) => call === 'status').length).toBe(reads);
	expect(owner.fenced).toBe(true);

	// The host's nudge reads and resends; lost, it recovers once more.
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(4);
	// Focus while fenced does the same.
	host.focus();
	await settle();
	expect(host.answers).toHaveLength(6);

	// Answers reach the host again: the next nudge settles the vote.
	host.loseAnswers(0);
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(7);
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });
	host.nudge();
	await settle();
	expect(host.answers).toHaveLength(7);
	expect(owner.fenced).toBe(true);
});

// ============================================================================
// The host's stop, and leaving
// ============================================================================

test('the stopped Bun host is reported to this window', async () => {
	const { host, departure } = await started();
	let stopped = 0;
	departure.onHostStopped(() => stopped++);
	host.stopHost();
	expect(stopped).toBe(1);
	expect(departure.hostStopped).toBe(true);
});

test('after destroy, nudges read nothing and nothing is answered', async () => {
	const { host, departure } = await started();
	departure.destroy();
	expect(host.calls.at(-1)).toBe('unlisten');
	const reads = host.calls.length;
	host.begin('quit');
	host.nudge();
	host.focus();
	await settle();
	expect(host.calls.length).toBe(reads);
	expect(host.answers).toEqual([]);
});

test('a page that leaves during a failed startup opens nothing and answers nothing', async () => {
	const host = createFakeHost();
	host.faultStatus('reject');
	const departure = track(createDeparture(host.port));
	const opener = ownerOpener();
	const opening = openPage(departure, opener);
	await departure.start();
	departure.destroy();
	await expect(opening).rejects.toThrow('left');
	expect(host.calls.at(-1)).toBe('unlisten');
	host.begin('quit');
	host.nudge();
	host.focus();
	await settle();
	expect(opener.calls).toBe(0);
	expect(host.answers).toEqual([]);
	const calls = host.calls.length;
	await departure.start();
	expect(host.calls.length).toBe(calls);
});
