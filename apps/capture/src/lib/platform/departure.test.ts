/**
 * Departure Tests
 *
 * The page's side of the host's departure wire, against a scripted host that
 * keeps one status and answers the way the wire describes, and a page that
 * is either recorded or the real collection over a real folder.
 *
 * Key behaviors:
 * - The listener is registered before the first status read, and the page is
 *   not editable until a status is idle
 * - A round fences the page before anything is awaited, answers `asking`,
 *   and then settles; a round that arrives while the folder opens waits for
 *   it; a page whose folder did not open answers `ready` and stays fenced
 * - The same round again with no vote re-sends `asking` only, with no second
 *   question; a newer round is taken up with no unfenced gap
 * - A lost answer never lifts the fence; an older idle is ignored; only a
 *   newer idle lifts it
 * - `granted`, `leaving`, and a `discarded` vote stay fenced and dismiss the
 *   question
 * - Neither choice changes what the page holds: after `ready` and another
 *   page's `cancel`, the open capture and its unsent text are as they were
 */
import '../svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	DEPARTURE_ANSWER_COMMAND,
	DEPARTURE_CHANGED_EVENT,
	DEPARTURE_STATUS_COMMAND,
	type DepartureAnswerArgs,
	type DepartureStatus,
	HOST_STOPPED_EVENT,
} from '@epicenter/epicenter/departure';
import {
	openCapture,
	openCaptures,
} from '../browser-folder.test-support.js';
import type {
	DepartureParticipant,
	DeparturePort,
} from './departure.svelte.ts';

const { createDeparture } = await import('./departure.svelte.ts');

type RoundStatus = Extract<DepartureStatus, { round: number }>;
/** A status before the host numbers it. */
type Unversioned = DepartureStatus extends infer Status
	? Status extends unknown
		? Omit<Status, 'version'>
		: never
	: never;

/** A host that keeps one status and answers this page as the wire says. */
function scriptedHost(initial: 'idle' | 'collecting' = 'idle') {
	let status: DepartureStatus =
		initial === 'idle'
			? { version: 1, generation: 1, phase: 'idle' }
			: {
					version: 1,
					generation: 1,
					phase: 'collecting',
					round: 1,
					intent: 'quit',
					vote: 'none',
				};
	const handlers = new Map<string, () => void>();
	const log: string[] = [];
	const answers: DepartureAnswerArgs[] = [];
	let focus: (() => void) | undefined;
	/** Held registrations, by event. */
	const heldListens = new Map<string, Promise<void>>();
	/** The next status read waits for this, then answers what was current when it began. */
	let heldRead: Promise<void> | undefined;
	/** The next answer is lost on its way. */
	let loseAnswer = false;

	function set(next: Unversioned) {
		status = { ...next, version: status.version + 1 } as DepartureStatus;
	}

	const port: DeparturePort = {
		async listen(event, handler) {
			log.push(`listen ${event}`);
			await heldListens.get(event);
			handlers.set(event, handler);
			log.push(`listening ${event}`);
			return () => handlers.delete(event);
		},
		async invoke(command, args) {
			log.push(command);
			if (command === DEPARTURE_STATUS_COMMAND) {
				const seen = status;
				const held = heldRead;
				heldRead = undefined;
				await held;
				return seen;
			}
			if (command !== DEPARTURE_ANSWER_COMMAND)
				throw new Error(`no ${command}`);
			const answer = args as DepartureAnswerArgs;
			answers.push(answer);
			if (loseAnswer) {
				loseAnswer = false;
				throw new Error('the reply was lost');
			}
			const current = status;
			if (
				current.phase !== 'collecting' ||
				current.generation !== answer.generation ||
				current.round !== answer.round
			)
				return current;
			if (answer.answer === 'cancel')
				set({ generation: current.generation, phase: 'idle' });
			else set({ ...current, vote: answer.answer });
			return status;
		},
		onFocus(listener) {
			focus = listener;
			return () => {
				focus = undefined;
			};
		},
	};
	return {
		port,
		log,
		answers,
		get status() {
			return status;
		},
		set,
		/** Start a round, or change the current one, and nudge the page. */
		round(next: Partial<Omit<RoundStatus, 'version'>>) {
			const base: Omit<RoundStatus, 'version'> =
				status.phase === 'idle'
					? {
							generation: status.generation,
							phase: 'collecting',
							round: 1,
							intent: 'quit',
							vote: 'none',
						}
					: (status as RoundStatus);
			set({ ...base, ...next });
			handlers.get(DEPARTURE_CHANGED_EVENT)?.();
		},
		idle() {
			set({ generation: status.generation, phase: 'idle' });
			handlers.get(DEPARTURE_CHANGED_EVENT)?.();
		},
		nudge: () => handlers.get(DEPARTURE_CHANGED_EVENT)?.(),
		emit: (event: string) => handlers.get(event)?.(),
		focus: () => focus?.(),
		holdListen(event: string) {
			const held = Promise.withResolvers<void>();
			heldListens.set(event, held.promise);
			return held.resolve;
		},
		holdRead() {
			const held = Promise.withResolvers<void>();
			heldRead = held.promise;
			return held.resolve;
		},
		loseNextAnswer() {
			loseAnswer = true;
		},
		listening: () => handlers.size,
	};
}

/** A page that records what it was asked to do. */
function recordedPage(held = 0) {
	const events: string[] = [];
	let settling = Promise.withResolvers<number>();
	const participant: DepartureParticipant = {
		fence: () => events.push('fence'),
		settle() {
			events.push('settle');
			return settling.promise;
		},
		resume: () => events.push('resume'),
	};
	return {
		participant,
		events,
		/** Finish the current settle with `count` things held. */
		settled(count = held) {
			settling.resolve(count);
			settling = Promise.withResolvers<number>();
		},
	};
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test('the listener is registered before the first status read, and the page is not editable until a status is idle', async () => {
	const host = scriptedHost();
	const release = host.holdListen(DEPARTURE_CHANGED_EVENT);
	const departure = createDeparture(host.port);
	await flush();
	expect(host.log).toEqual([`listen ${DEPARTURE_CHANGED_EVENT}`]);
	expect(departure.everIdle).toBe(false);

	release();
	await departure.ready;
	expect(host.log).toEqual([
		`listen ${DEPARTURE_CHANGED_EVENT}`,
		`listening ${DEPARTURE_CHANGED_EVENT}`,
		`listen ${HOST_STOPPED_EVENT}`,
		`listening ${HOST_STOPPED_EVENT}`,
		DEPARTURE_STATUS_COMMAND,
	]);
	expect(departure.everIdle).toBe(true);
	expect(departure.fenced).toBe(false);
	departure.close();
	expect(host.listening()).toBe(0);
});

test('a refused registration stays visible and is tried again; nothing is editable meanwhile', async () => {
	const host = scriptedHost();
	let refuse = true;
	const departure = createDeparture({
		...host.port,
		listen(event, handler) {
			if (refuse) return Promise.reject(new Error('event.listen not allowed'));
			return host.port.listen(event, handler);
		},
	});
	await departure.ready;
	expect(departure.startProblem).toContain('event.listen not allowed');
	expect(departure.everIdle).toBe(false);
	expect(host.log).not.toContain(DEPARTURE_STATUS_COMMAND);

	refuse = false;
	await departure.retry();
	expect(departure.startProblem).toBeUndefined();
	expect(departure.everIdle).toBe(true);
	departure.close();
});

test('a round that arrives while the folder opens is answered asking at once and settled once the folder is there', async () => {
	const host = scriptedHost('collecting');
	const departure = createDeparture(host.port);
	await departure.ready;
	await flush();
	expect(departure.fenced).toBe(true);
	expect(departure.everIdle).toBe(false);
	expect(host.answers.map((answer) => answer.answer)).toEqual(['asking']);

	const page = recordedPage();
	departure.attach(page.participant);
	// Fenced before it settles.
	expect(page.events).toEqual(['fence', 'settle']);
	page.settled(0);
	await flush();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(departure.fenced).toBe(true);

	// Another page cancels: the round ends, and only then is the page given back.
	host.idle();
	await flush();
	expect(departure.fenced).toBe(false);
	expect(departure.everIdle).toBe(true);
	expect(page.events).toEqual(['fence', 'settle', 'resume']);
	departure.close();
});

test('a page whose folder did not open answers ready, and stays fenced until the host is idle', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	departure.attach(null);
	host.round({ intent: 'restart' });
	await flush();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
	]);
	expect(departure.fenced).toBe(true);
	expect(departure.intent).toBe('restart');
	host.idle();
	await flush();
	expect(departure.fenced).toBe(false);
	departure.close();
});

test('the same round again with no vote re-sends asking only, and never asks the person twice', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({});
	await flush();
	page.settled(2);
	await flush();
	const prompt = departure.prompt;
	expect(prompt).toEqual({ intent: 'quit', held: 2 });

	// Quit pressed again: the host resets this page's vote.
	host.round({ vote: 'none' });
	await flush();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'asking',
	]);
	expect(departure.prompt).toBe(prompt);
	expect(page.events).toEqual(['fence', 'settle']);
	departure.close();
});

test('a newer round is taken up while still fenced, with no moment in which input is taken', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({ intent: 'restart' });
	await flush();
	page.settled(1);
	await flush();
	expect(departure.prompt?.intent).toBe('restart');

	host.round({ round: 2, intent: 'quit', vote: 'none' });
	await flush();
	// The old question is gone; the page was never given back between rounds.
	expect(departure.prompt).toBeUndefined();
	expect(departure.fenced).toBe(true);
	expect(page.events).toEqual(['fence', 'settle', 'settle']);
	page.settled(1);
	await flush();
	expect(departure.prompt).toEqual({ intent: 'quit', held: 1 });

	departure.keepWorking();
	await flush();
	expect(host.answers.at(-1)).toEqual({
		generation: 1,
		round: 2,
		answer: 'cancel',
	});
	expect(departure.fenced).toBe(false);
	expect(page.events.at(-1)).toBe('resume');
	departure.close();
});

test('a lost answer never lifts the fence; the next read sends the same answer again, and only the idle after it lifts it', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({});
	await flush();
	page.settled(1);
	await flush();

	host.loseNextAnswer();
	departure.keepWorking();
	await flush();
	expect(departure.answerProblem).toContain('lost');
	expect(departure.fenced).toBe(true);
	expect(host.status.phase).toBe('collecting');
	expect(page.events).toEqual(['fence', 'settle']);

	// Focus while fenced reads again: the host never got the answer, so the
	// page sends it again, for this round. The host's idle lifts the fence.
	host.focus();
	await flush();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'cancel',
		'cancel',
	]);
	expect(departure.prompt).toBeUndefined();
	expect(departure.fenced).toBe(false);
	expect(page.events).toEqual(['fence', 'settle', 'resume']);
	departure.close();
});

test('a decided ready is sent again when Quit is pressed again, with no new question and nothing changed', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({ intent: 'restart' });
	await flush();
	page.settled(2);
	await flush();
	departure.discard();
	await flush();
	expect(host.status).toMatchObject({ phase: 'collecting', vote: 'ready' });

	// Quit pressed again resets this page's vote for the same round.
	host.round({ vote: 'none' });
	await flush();
	expect(host.answers.map((answer) => answer.answer)).toEqual([
		'asking',
		'ready',
		'ready',
	]);
	expect(host.status).toMatchObject({ vote: 'ready' });
	expect(departure.prompt).toBeUndefined();
	expect(departure.fenced).toBe(true);
	expect(page.events).toEqual(['fence', 'settle']);
	departure.close();
});

test('an idle older than the newest status is ignored; only a newer idle lifts the fence', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({});
	await flush();
	page.settled(1);
	await flush();

	// An out-of-order idle: a read begun before the round finishes last.
	const releaseRead = host.holdRead();
	host.set({ generation: 1, phase: 'idle' });
	const olderIdle = host.status.version;
	host.nudge();
	host.round({ round: 2 });
	await flush();
	releaseRead();
	await flush();
	expect(olderIdle).toBeLessThan(host.status.version);
	expect(departure.fenced).toBe(true);
	expect(page.events.includes('resume')).toBe(false);

	host.idle();
	await flush();
	expect(departure.fenced).toBe(false);
	expect(page.events.at(-1)).toBe('resume');
	departure.close();
});

test('granted, leaving, and a discarded vote stay fenced and dismiss the question', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	const page = recordedPage();
	departure.attach(page.participant);
	host.round({});
	await flush();
	page.settled(1);
	await flush();
	expect(departure.prompt).toBeDefined();

	// The person discarded this page in the native dialog.
	host.round({ vote: 'discarded' });
	await flush();
	expect(departure.prompt).toBeUndefined();
	expect(departure.fenced).toBe(true);
	for (const phase of ['granted', 'leaving'] as const) {
		host.round({ phase });
		await flush();
		expect(departure.fenced).toBe(true);
	}
	expect(page.events).toEqual(['fence', 'settle']);
	departure.close();
});

test('the stopped Bun host is reported to this window', async () => {
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	let stopped = 0;
	departure.onHostStopped(() => stopped++);
	host.emit(HOST_STOPPED_EVENT);
	expect(stopped).toBe(1);
	expect(departure.hostStopped).toBe(true);
	departure.close();
});

/** The real store over a real browser folder, with one capture open. */
async function realPage() {
	const harness = await openCaptures({
		'captures/one.md':
			'---\ncapturedAt: 2026-10-01T02:30:00.000Z\n---\n\nA\n\n## Thoughts\n',
	});
	const { captures } = harness;
	await captures.open('one', 'capture');
	return { harness, captures, ...openCapture(captures) };
}

test('a page that answers ready changes nothing it holds; when another page cancels, everything is back as it was', async () => {
	const { harness, captures, session, form } = await realPage();
	form.inputText('Typed: saves on its own');
	form.inputNewThought('Held: never added on its own');
	captures.inputNewCapture('A new capture, not added');
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	departure.attach(captures.departure);

	host.round({});
	await flush();
	// Fenced as the round was read, before the page settled anything.
	expect(captures.fenced).toBe(true);
	form.inputNewThought('refused');
	await Bun.sleep(20);
	expect(departure.prompt).toEqual({ intent: 'quit', held: 2 });

	departure.discard();
	await flush();
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(departure.fenced).toBe(true);
	expect(captures.opened?.kind).toBe('capture');
	expect(form.newThought).toBe('Held: never added on its own');
	expect(captures.newCapture).toBe('A new capture, not added');

	// Another page chose Keep working: the round ends.
	host.idle();
	await flush();
	expect(captures.fenced).toBe(false);
	expect(session.locked).toBe(false);
	expect(form.newThought).toBe('Held: never added on its own');
	expect(form.text).toBe('Typed: saves on its own');
	form.inputNewThought('Held, and now added');
	expect(form.addThought()).toBe(true);
	departure.close();
	await harness.close();
});

test('with a failed save, discarding is only a vote: the text and the failure stay', async () => {
	const { harness, captures, session, form } = await realPage();
	harness.failNextWrite('captures/one.md');
	form.inputText('Mine');
	expect((await session.settled()).status).toBe('error');
	const host = scriptedHost();
	const departure = createDeparture(host.port);
	await departure.ready;
	departure.attach(captures.departure);

	host.round({ intent: 'restart' });
	await flush();
	await Bun.sleep(20);
	expect(departure.prompt).toEqual({ intent: 'restart', held: 1 });
	departure.discard();
	await flush();
	expect(form.text).toBe('Mine');
	expect(session.state.status).toBe('error');

	host.idle();
	await flush();
	expect(form.text).toBe('Mine');
	expect(session.state.status).toBe('error');
	expect(captures.fenced).toBe(false);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await harness.text('captures/one.md')).toContain('\nMine\n');
	departure.close();
	await harness.close();
});
