/**
 * Device preferences tests
 *
 * The chosen microphone is kept in the same device file as the API key,
 * under the folder's `.git`. These drive the host through the real bridge
 * encoding against a real directory and read the file that results.
 *
 * Key behaviors:
 * - Saving a microphone keeps the key and every field the app does not know;
 *   saving a key keeps the microphone and those fields
 * - A key save and a microphone save that overlap both land
 * - No preference reply carries the key
 * - A key from the environment does not stop a microphone from being saved,
 *   and the key saved in the file is left as it was
 * - A preference that does not read as one is refused and writes nothing
 * - A device file that cannot be read is not replaced
 */
import { afterEach, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHttpBridge } from '../src/lib/bridge/http.js';
import { createHost, type HostOptions } from './host.js';

const TOKEN = 'test-token';
const ORIGIN = 'http://127.0.0.1:4999';
const SECRET = 'device-secret-key';
const USB = { deviceId: 'usb-id', label: 'USB Microphone' };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function start(overrides: Partial<HostOptions> = {}) {
	const directory = await realpath(
		await mkdtemp(join(tmpdir(), 'whispering-device-')),
	);
	const root = join(directory, 'data');
	await mkdir(root);
	const logged: string[] = [];
	const host = await createHost({
		root,
		token: TOKEN,
		uiDist: undefined,
		debug: false,
		fixturePath: undefined,
		env: {},
		log: (message) => logged.push(message),
		...overrides,
	});
	host.listening(4999);
	/** Every reply body the host sent, as text. */
	const replies: string[] = [];
	const bridge = createHttpBridge({
		origin: ORIGIN,
		token: TOKEN,
		async fetch(input, init) {
			const response = await host.handle(new Request(input, init));
			replies.push(await response.clone().text());
			return response;
		},
	});
	cleanups.push(async () => {
		await host.close();
		await rm(directory, { recursive: true, force: true });
	});
	const deviceFile = join(
		root,
		'.git',
		'epicenter',
		'whispering',
		'device.json',
	);
	return {
		bridge,
		deviceFile,
		logged,
		replies,
		saved: async () =>
			JSON.parse(await readFile(deviceFile, 'utf8')) as Record<string, unknown>,
		async seed(values: Record<string, unknown>) {
			await mkdir(join(deviceFile, '..'), { recursive: true });
			await writeFile(deviceFile, `${JSON.stringify(values)}\n`);
		},
	};
}

test('saving a microphone keeps the key and unknown fields, and no reply or log carries the key', async () => {
	const { bridge, saved, seed, replies, logged } = await start();
	await seed({
		transcriptionApiKey: SECRET,
		addedByALaterBuild: { keep: true },
	});

	expect(await bridge.app<unknown>('preferences')).toEqual({
		microphone: null,
	});
	expect(
		await bridge.app<unknown>('set-preferences', { microphone: USB }),
	).toEqual({ microphone: USB });

	expect(await saved()).toEqual({
		transcriptionApiKey: SECRET,
		addedByALaterBuild: { keep: true },
		microphone: USB,
	});
	expect(await bridge.app<unknown>('preferences')).toEqual({ microphone: USB });
	// The key is still the one in use.
	expect(
		await bridge.app<{ credentialPresent: boolean }>('info'),
	).toMatchObject({ credentialPresent: true });
	expect([...replies, ...logged].join('\n')).not.toContain(SECRET);
});

test('saving a key keeps the microphone and unknown fields; forgetting the microphone keeps the key', async () => {
	const { bridge, saved, seed } = await start();
	await seed({ microphone: USB, addedByALaterBuild: 7 });

	await bridge.app('credential', { key: SECRET });
	expect(await saved()).toEqual({
		microphone: USB,
		addedByALaterBuild: 7,
		transcriptionApiKey: SECRET,
	});

	expect(
		await bridge.app<unknown>('set-preferences', { microphone: null }),
	).toEqual({ microphone: null });
	expect(await saved()).toEqual({
		addedByALaterBuild: 7,
		transcriptionApiKey: SECRET,
	});
});

test('a key save and microphone saves that overlap all land', async () => {
	const { bridge, saved } = await start();

	await Promise.all([
		bridge.app('credential', { key: SECRET }),
		bridge.app('set-preferences', { microphone: USB }),
		bridge.app('credential', { key: `${SECRET}-2` }),
	]);

	expect(await saved()).toEqual({
		transcriptionApiKey: `${SECRET}-2`,
		microphone: USB,
	});
});

test('a key from the environment does not stop a microphone save, and the saved key is left as it was', async () => {
	const { bridge, saved, seed, replies } = await start({
		env: { WHISPERING_TRANSCRIPTION_API_KEY: 'environment-key' },
	});
	await seed({ transcriptionApiKey: SECRET });

	expect(
		await bridge.app<unknown>('set-preferences', { microphone: USB }),
	).toEqual({ microphone: USB });

	expect(await saved()).toEqual({
		transcriptionApiKey: SECRET,
		microphone: USB,
	});
	await expect(bridge.app('credential', { key: 'typed-key' })).rejects.toThrow(
		'cannot be changed here',
	);
	expect(await saved()).toEqual({
		transcriptionApiKey: SECRET,
		microphone: USB,
	});
	expect(replies.join('\n')).not.toContain(SECRET);
	expect(replies.join('\n')).not.toContain('environment-key');
});

test('a preference that does not read as a microphone is refused and writes nothing', async () => {
	const { bridge, deviceFile, seed } = await start();
	await seed({ transcriptionApiKey: SECRET });
	const before = await readFile(deviceFile, 'utf8');

	for (const microphone of [
		undefined,
		'usb-id',
		{ deviceId: '', label: 'x' },
		{ deviceId: 'usb-id' },
		{ deviceId: 'x'.repeat(513), label: '' },
	])
		await expect(bridge.app('set-preferences', { microphone })).rejects.toThrow(
			'A microphone preference is',
		);

	expect(await readFile(deviceFile, 'utf8')).toBe(before);
	// A saved value that is not a microphone reads as none, and is not returned.
	await seed({ transcriptionApiKey: SECRET, microphone: { deviceId: 5 } });
	expect(await bridge.app<unknown>('preferences')).toEqual({
		microphone: null,
	});
});

test('a device file that cannot be read is not replaced by a microphone save', async () => {
	const { bridge, deviceFile, seed } = await start();
	await seed({ transcriptionApiKey: SECRET });
	const before = await readFile(deviceFile, 'utf8');
	await chmod(deviceFile, 0o000);
	cleanups.push(() => chmod(deviceFile, 0o600));

	await expect(
		bridge.app('set-preferences', { microphone: USB }),
	).rejects.toThrow();

	await chmod(deviceFile, 0o600);
	expect(await readFile(deviceFile, 'utf8')).toBe(before);
});
