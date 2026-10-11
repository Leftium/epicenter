/**
 * Sync Review Mounted Tests
 *
 * Mounts the real `SyncReview` in jsdom over a hand-built attempt, the plain
 * data `folder.sync.run()` returns, inside a host that shows and hides it as
 * an app does. Buttons are clicked and results typed through the DOM.
 *
 * Key behaviors:
 * - Each conflict shows both captured versions; Apply waits for a choice
 *   for every conflict
 * - `Use this` takes a side; typing replaces with text, or with JSON once
 *   it parses; `Leave out` removes; a body cannot be left out
 * - Apply hands over the attempt and one choice per conflict ID, and later
 *   edits do not change what was handed over
 * - Back hides the review and keeps its choices
 * - Refused choices show beside their rows
 *
 * Run with `bun run test:mounted`.
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import type {
	SyncAttempt,
	SyncChoiceProblem,
	SyncChoices,
} from '@epicenter/folder';
import { click, type } from './svelte-dom.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { default: SyncReviewHost } = await import(
	'./fixtures/SyncReviewHost.svelte'
);

const attempt: SyncAttempt = {
	kind: 'needsChoices',
	id: 'attempt-1',
	local: 'a'.repeat(40),
	incoming: 'b'.repeat(40),
	conflicts: [
		{
			id: 'size',
			kind: 'setting',
			path: 'kv.json',
			key: 'size',
			base: { present: true, value: 1 },
			local: { present: true, value: 2 },
			incoming: { present: true, value: 3 },
		},
		{
			id: 'title',
			kind: 'field',
			path: 'todos/walk.md',
			field: 'title',
			base: { present: true, value: 'Walk' },
			local: { present: true, value: 'Evening walk' },
			incoming: { present: true, value: 'Morning walk' },
		},
		{
			id: 'body',
			kind: 'body',
			path: 'todos/walk.md',
			base: { present: true, value: 'Left at dawn.\n' },
			local: { present: true, value: 'Left at six.\n' },
			incoming: { present: true, value: 'Left at seven.\n' },
		},
	],
};

const cleanup: (() => void)[] = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

function setup() {
	const applied: { attempt: SyncAttempt; choices: SyncChoices }[] = [];
	const controls: {
		reopen?: () => void;
		refuse?: (problems: readonly SyncChoiceProblem[]) => void;
	} = {};
	const target = document.createElement('div');
	document.body.append(target);
	const view = mount(SyncReviewHost, {
		target,
		props: {
			attempt,
			controls,
			onApply: (attempt: SyncAttempt, choices: SyncChoices) =>
				applied.push({ attempt, choices }),
		},
	});
	flushSync();
	cleanup.push(() => {
		void unmount(view);
		target.remove();
	});
	/** The part of the review for one conflict, by its name. */
	const row = (name: string) => {
		const found = target.querySelector(`[role="group"][aria-label="${name}"]`);
		if (found === null) throw new Error(`No row for ${name}`);
		return found;
	};
	const result = (name: string) =>
		target.querySelector<HTMLTextAreaElement>(
			`textarea[aria-label="Result for ${name}"]`,
		);
	const apply = () =>
		target.querySelector<HTMLButtonElement>('button[type="submit"]');
	return { target, applied, controls, row, result, apply };
}

/** The `Use this` button for one side of a row. */
function useThis(row: Element, side: 0 | 1) {
	const buttons = [...row.querySelectorAll('button')].filter(
		(button) => button.textContent?.trim() === 'Use this',
	);
	buttons[side]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
	flushSync();
}

test('each conflict shows both versions, and Apply waits for every choice', () => {
	const { target, row, apply } = setup();
	const title = row('title');
	expect(
		[...title.querySelectorAll('textarea[readonly]')].map(
			(area) => (area as HTMLTextAreaElement).value,
		),
	).toEqual(['Evening walk', 'Morning walk']);
	expect(
		[...row('size').querySelectorAll('textarea[readonly]')].map(
			(area) => (area as HTMLTextAreaElement).value,
		),
	).toEqual(['2', '3']);
	expect(target.textContent).toContain('0 of 3 chosen');
	expect(apply()?.disabled).toBe(true);
	// A body has no Leave out.
	expect(row('Body').textContent).not.toContain('Leave out');
});

test('choices take, replace, and remove, and Apply hands over one per conflict', () => {
	const { target, applied, row, result, apply } = setup();
	useThis(row('Body'), 1);
	expect(result('Body')?.value).toBe('Left at seven.\n');

	type(result('title'), 'Walk at noon');
	flushSync();
	// A number is edited as JSON: not applied until it parses.
	type(result('size'), '4,');
	flushSync();
	expect(target.textContent).toContain('Not a value yet');
	expect(apply()?.disabled).toBe(true);
	type(result('size'), '4');
	flushSync();
	expect(target.textContent).toContain('3 of 3 chosen');

	click(target, 'Apply and sync');
	flushSync();
	expect(applied).toEqual([
		{
			attempt,
			choices: {
				body: { kind: 'take', side: 'incoming' },
				title: { kind: 'replace', value: 'Walk at noon' },
				size: { kind: 'replace', value: 4 },
			},
		},
	]);

	// Later edits never reach what was handed over.
	click(row('title'), 'Leave out');
	flushSync();
	expect(applied[0]?.choices.title).toEqual({
		kind: 'replace',
		value: 'Walk at noon',
	});
	expect(target.textContent).toContain('title will be left out');
	click(target, 'Apply and sync');
	flushSync();
	expect(applied[1]?.choices.title).toEqual({ kind: 'remove' });
});

test('Back hides the review and keeps its choices', () => {
	const { target, controls, row, result } = setup();
	useThis(row('title'), 0);
	click(target, 'Back');
	flushSync();
	expect(target.querySelector('form')).toBeNull();
	controls.reopen?.();
	flushSync();
	expect(result('title')?.value).toBe('Evening walk');
	expect(target.textContent).toContain('1 of 3 chosen');
});

test('refused choices show beside their rows', () => {
	const { controls, row, result } = setup();
	controls.refuse?.([
		{
			conflictId: 'size',
			reason: 'invalid',
			message: 'size must be at most 3',
		},
	]);
	flushSync();
	expect(row('size').textContent).toContain('size must be at most 3');
	expect(result('size')?.getAttribute('aria-invalid')).toBe('true');
	expect(row('title').textContent).not.toContain('at most');
});
