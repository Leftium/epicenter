/** The browser leaf reaches the page's Clipboard API at call time. */
import { afterEach, expect, test } from 'bun:test';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { clipboard } from './clipboard/browser.js';

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'navigator', original);
	else Reflect.deleteProperty(globalThis, 'navigator');
});

function installNavigatorClipboard(text: { value: string }) {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			clipboard: {
				readText: async () => text.value,
				async writeText(next: string) {
					text.value = next;
				},
			},
		},
	});
}

test('reads and writes through navigator.clipboard', async () => {
	const text = { value: '' };
	installNavigatorClipboard(text);
	expect(expectOk(await clipboard.readText())).toBeNull();
	expectOk(await clipboard.writeText('page'));
	expect(text.value).toBe('page');
	expect(expectOk(await clipboard.readText())).toBe('page');
});

test('a missing Clipboard API is a ClipboardError, not a throw', async () => {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {},
	});
	expect(expectErr(await clipboard.readText()).name).toBe('ClipboardRead');
	expect(expectErr(await clipboard.writeText('x')).name).toBe('ClipboardWrite');
});
