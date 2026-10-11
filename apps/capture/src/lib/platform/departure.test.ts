/**
 * Departure Tests
 *
 * The real Capture store behind the shared departure client
 * (`@epicenter/epicenter/departure/page`), over a real browser folder and a
 * stand-in for the host's side of the wire. The client's own rules are
 * tested beside it in `apps/epicenter`; these tests cover what this store
 * counts and gives back.
 *
 * Key behaviors:
 * - Neither choice changes what the page holds: after `ready` and another
 *   page's `cancel`, the open capture and its unsent text are as they were
 * - With a failed save, discarding is only a vote: the text and the failure
 *   stay until the person saves again
 */
import '../svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { Departure } from '@epicenter/epicenter/departure/page';
import { createFakeHost } from '../../../../epicenter/src/departure-page.test-support.js';
import { openCapture, openCaptures } from '../browser-folder.test-support.js';

const { createDeparture } = await import('@epicenter/epicenter/departure/page');

/** Let reads, answers, saves, and settles run. */
async function settle() {
	for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

async function eventually(done: () => boolean) {
	for (let waited = 0; waited < 400 && !done(); waited++) await Bun.sleep(5);
}

/** The identity of the prompt shown now, as its controls carry it. */
function shownPrompt(departure: Departure): number {
	const notice = departure.notice;
	if (notice?.stage !== 'choose')
		throw new Error(`Expected a prompt, got ${notice?.stage}`);
	return notice.id;
}

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
	const host = createFakeHost();
	const departure = createDeparture(host.port);
	await departure.start();
	departure.attach(captures.departure);

	host.begin('quit');
	host.nudge();
	await settle();
	// Fenced as the round was read, before the page settled anything.
	expect(captures.fenced).toBe(true);
	form.inputNewThought('refused');
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toMatchObject({ intent: 'quit', held: 2 });

	departure.leaveAnyway(shownPrompt(departure));
	await settle();
	expect(host.answers.at(-1)?.answer).toBe('ready');
	expect(departure.fenced).toBe(true);
	expect(captures.opened?.kind).toBe('capture');
	expect(form.newThought).toBe('Held: never added on its own');
	expect(captures.newCapture).toBe('A new capture, not added');

	// Another page chose Keep working: the round ends.
	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(captures.fenced).toBe(false);
	expect(session.locked).toBe(false);
	expect(form.newThought).toBe('Held: never added on its own');
	expect(form.text).toBe('Typed: saves on its own');
	form.inputNewThought('Held, and now added');
	expect(form.addThought()).toBe(true);
	departure.destroy();
	await harness.close();
});

test('with a failed save, discarding is only a vote: the text and the failure stay', async () => {
	const { harness, captures, session, form } = await realPage();
	harness.failNextWrite('captures/one.md');
	form.inputText('Mine');
	expect((await session.settled()).status).toBe('error');
	const host = createFakeHost();
	const departure = createDeparture(host.port);
	await departure.start();
	departure.attach(captures.departure);

	host.begin('restart');
	host.nudge();
	await eventually(() => departure.notice?.stage === 'choose');
	expect(departure.notice).toMatchObject({ intent: 'restart', held: 1 });
	departure.leaveAnyway(shownPrompt(departure));
	await settle();
	expect(form.text).toBe('Mine');
	expect(session.state.status).toBe('error');

	host.set({ phase: 'idle' });
	host.nudge();
	await settle();
	expect(form.text).toBe('Mine');
	expect(session.state.status).toBe('error');
	expect(captures.fenced).toBe(false);
	session.retry();
	expect((await session.settled()).status).toBe('saved');
	expect(await harness.text('captures/one.md')).toContain('\nMine\n');
	departure.destroy();
	await harness.close();
});
