/** Browser preference failures must reach the microphone chooser, not become System default. */
import { afterEach, expect, mock, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { Ok } from 'wellcrafted/result';
import { openTestWorkspace } from '../workspace.test-support.js';
import type { Workspace } from './types.js';

// Compile the Vite build flag for this adapter test; no microphone is opened.
Bun.plugin({
	name: 'browser-workspace-build-flag',
	setup(build) {
		build.onLoad({ filter: /\/workspace\/browser\.ts$/ }, async ({ path }) => ({
			contents: new Bun.Transpiler({
				loader: 'ts',
				define: { 'import.meta.env.DEV': 'false' },
			}).transformSync(await Bun.file(path).text()),
			loader: 'js',
		}));
	},
});

let folder: Workspace['folder'];
mock.module('@epicenter/folder/browser', () => ({
	openFolder: async () => Ok(folder),
}));
const { openBrowserWorkspace } = await import('./browser.js');
const originalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	'localStorage',
);
const originalLocation = Object.getOwnPropertyDescriptor(
	globalThis,
	'location',
);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
	for (const [name, descriptor] of [
		['localStorage', originalStorage],
		['location', originalLocation],
	] as const) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
});

async function preferences(getItem: (key: string) => string | null) {
	const workspace = await openTestWorkspace();
	folder = workspace.workspace.folder;
	Object.defineProperty(globalThis, 'localStorage', {
		configurable: true,
		value: { getItem },
	});
	Object.defineProperty(globalThis, 'location', {
		configurable: true,
		value: new URL('http://localhost:5199'),
	});
	const browser = expectOk(await openBrowserWorkspace());
	cleanups.push(async () => {
		await browser.close();
		await workspace.remove();
	});
	return browser.preferences;
}

test('missing and valid microphone preferences retain their meaning', async () => {
	let saved: string | null = null;
	const reader = await preferences((key) => {
		expect(key).toBe('whispering.microphone');
		return saved;
	});
	expect(await reader.microphone()).toBeUndefined();
	saved = JSON.stringify({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
	expect(await reader.microphone()).toEqual({
		deviceId: 'fixture-input',
		label: 'Fixture microphone',
	});
});

test('a refused storage read rejects instead of selecting System default', async () => {
	const reader = await preferences(() => {
		throw new Error('Storage access refused');
	});
	await expect(reader.microphone()).rejects.toThrow('Storage access refused');
});

test('malformed microphone JSON rejects instead of selecting System default', async () => {
	const reader = await preferences(() => '{broken');
	await expect(reader.microphone()).rejects.toBeInstanceOf(SyntaxError);
});
