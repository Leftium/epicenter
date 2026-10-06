/**
 * Shared editor control lifetimes.
 * Tabs unmount inactive panels, retired text controls stop reading and writing,
 * new panels receive current input, and forceMount explicitly retains a panel.
 * Exercises the public Input, Textarea, and Tabs exports with delivered events.
 */
import { expect, test } from 'bun:test';
import { flushSync, mount, unmount } from 'svelte';
import { click, type } from '../svelte-dom.test-support.js';

const { default: TabsLifecycle } = await import(
	'./fixtures/TabsLifecycle.svelte'
);

function setup(forceMount = false) {
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	let value = 'original';
	let reads = 0;
	const writes: string[] = [];
	const view = mount(TabsLifecycle, {
		target,
		props: {
			forceMount,
			read: () => {
				reads++;
				return value;
			},
			write: (input: string) => {
				value = input;
				writes.push(input);
			},
		},
	});
	flushSync();
	const field = () =>
		target.querySelector<HTMLInputElement>('[aria-label="Field"]');
	const body = () =>
		target.querySelector<HTMLTextAreaElement>('[aria-label="Body"]');
	const tab = (name: string) => {
		const button = [...target.querySelectorAll('button')].find(
			(node) => node.textContent?.trim() === name,
		);
		if (!button) throw new Error('fixture');
		click(button);
		flushSync();
	};
	return { target, view, writes, field, body, tab, reads: () => reads };
}

test('inactive panels unmount and their retired text controls remain inert after the panel returns', async () => {
	const t = setup();
	try {
		const field = t.field();
		const body = t.body();
		type(body, 'accepted');
		expect(t.writes).toEqual(['accepted']);
		t.tab('Second');
		expect(t.field()).toBeNull();
		expect(t.body()).toBeNull();
		expect(t.target.querySelector('section')?.textContent).toBe('Second panel');
		const reads = t.reads();
		type(field, 'late field');
		type(body, 'late body');
		expect(t.reads()).toBe(reads);
		expect(t.writes).toEqual(['accepted']);
		t.tab('First');
		expect(t.field()).not.toBe(field);
		expect(t.body()).not.toBe(body);
		expect(t.body()?.value).toBe('accepted');
		type(field, 'old field after return');
		type(body, 'old body after return');
		type(t.body(), 'new body');
		expect(t.writes).toEqual(['accepted', 'new body']);
	} finally {
		await unmount(t.view);
	}
});

test('forceMount retains the same hidden panel and its controls across tab changes', async () => {
	const t = setup(true);
	try {
		const body = t.body();
		t.tab('Second');
		expect(t.body()).toBe(body);
		expect(body?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(
			true,
		);
		t.tab('First');
		expect(t.body()).toBe(body);
		expect(body?.closest('[role="tabpanel"]')?.hasAttribute('hidden')).toBe(
			false,
		);
	} finally {
		await unmount(t.view);
	}
});
