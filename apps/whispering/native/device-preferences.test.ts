/**
 * Device preferences tests
 *
 * The chosen microphone is kept in the same device file as the connections
 * and their keys, under the folder's `.git`. These drive the host through the
 * real bridge encoding against a real directory and read the file that
 * results.
 *
 * Key behaviors:
 * - Saving a microphone keeps the connections, an earlier build's key, and
 *   every field the app does not know; saving a connection keeps the
 *   microphone and those fields
 * - Connection saves and a microphone save that overlap all land
 * - No preference or connection reply carries a key
 * - A key from the environment does not stop a microphone from being saved,
 *   and the key saved in the file is left as it was
 * - A preference that does not read as one is refused and writes nothing
 * - A device file that cannot be read is not replaced
 * - A device file that is there and is not one JSON object is refused and
 *   left byte for byte, by key saves and microphone saves alike, and the
 *   refusal quotes none of it
 */
import { afterEach, expect, test } from 'bun:test';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
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
const BASE_URL = 'http://127.0.0.1:18080/v1';

/** A text connection with this key, as the Settings form saves it. */
const textConnection = (key: string) => ({
	operation: 'text',
	baseUrl: BASE_URL,
	model: 'chat-model',
	key: { action: 'replace', key },
});
/** The connection as the device file holds it. */
const stored = (key: string) => ({
	baseUrl: BASE_URL,
	model: 'chat-model',
	apiKey: key,
});

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

test('saving a microphone keeps the keys and unknown fields, and no reply or log carries a key', async () => {
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
	// The earlier key is still there, still sent nowhere until it is moved.
	expect(await bridge.app('connections')).toMatchObject({ legacyKey: true });
	expect([...replies, ...logged].join('\n')).not.toContain(SECRET);
});

test('saving a connection keeps the microphone and unknown fields; forgetting the microphone keeps the connection', async () => {
	const { bridge, saved, seed, replies } = await start();
	await seed({ microphone: USB, addedByALaterBuild: 7 });

	await bridge.app('set-connection', textConnection(SECRET));
	expect(await saved()).toEqual({
		microphone: USB,
		addedByALaterBuild: 7,
		textConnection: stored(SECRET),
	});

	expect(
		await bridge.app<unknown>('set-preferences', { microphone: null }),
	).toEqual({ microphone: null });
	expect(await saved()).toEqual({
		addedByALaterBuild: 7,
		textConnection: stored(SECRET),
	});
	expect(replies.join('\n')).not.toContain(SECRET);
});

test('connection saves and microphone saves that overlap all land', async () => {
	const { bridge, saved } = await start();

	await Promise.all([
		bridge.app('set-connection', textConnection(SECRET)),
		bridge.app('set-preferences', { microphone: USB }),
		bridge.app('set-connection', {
			...textConnection(`${SECRET}-2`),
			operation: 'transcription',
		}),
		bridge.app('set-connection', textConnection(`${SECRET}-3`)),
	]);

	expect(await saved()).toEqual({
		textConnection: stored(`${SECRET}-3`),
		transcriptionConnection: stored(`${SECRET}-2`),
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
	await expect(
		bridge.app('set-connection', {
			...textConnection('typed-key'),
			operation: 'transcription',
		}),
	).rejects.toThrow('comes from WHISPERING_TRANSCRIPTION_API_KEY');
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

test('a device file that is not one JSON object is refused and left as it is, by key and microphone saves alike', async () => {
	// Cut short mid-write by something else: the key and a later build's field are still recoverable by hand.
	const truncated = `{"transcriptionApiKey":"${SECRET}","addedByALaterBuild":{"keep":true}`;
	for (const contents of [
		truncated,
		'',
		'null',
		`["${SECRET}"]`,
		`"${SECRET}"`,
		'7',
	]) {
		const { bridge, deviceFile, replies, logged } = await start();
		await mkdir(join(deviceFile, '..'), { recursive: true });
		await writeFile(deviceFile, contents);

		await expect(
			bridge.app('set-preferences', { microphone: USB }),
		).rejects.toThrow('does not read as a JSON object');
		await expect(
			bridge.app('set-preferences', { microphone: null }),
		).rejects.toThrow('does not read as a JSON object');
		await expect(
			bridge.app('set-connection', textConnection('new-key')),
		).rejects.toThrow('does not read as a JSON object');
		await expect(
			bridge.app('adopt-legacy-key', {
				targets: { text: { baseUrl: BASE_URL, model: 'chat-model' } },
			}),
		).rejects.toThrow('does not read as a JSON object');
		await expect(bridge.app('preferences')).rejects.toThrow(
			'does not read as a JSON object',
		);

		expect(await readFile(deviceFile, 'utf8')).toBe(contents);
		// Nothing was staged beside it either.
		expect(await readdir(join(deviceFile, '..'))).toEqual(['device.json']);
		// Connections that cannot be read are reported as that, never as none
		// set up, and no key is quoted anywhere.
		await expect(bridge.app('connections')).rejects.toThrow(
			'does not read as a JSON object',
		);
		expect([...replies, ...logged].join('\n')).not.toContain(SECRET);
		expect([...replies, ...logged].join('\n')).not.toContain(
			'addedByALaterBuild',
		);
	}
});

test('once the file is repaired by hand, saves work again and keep what it holds', async () => {
	const { bridge, deviceFile, saved, seed } = await start();
	await mkdir(join(deviceFile, '..'), { recursive: true });
	await writeFile(deviceFile, `{"transcriptionApiKey":"${SECRET}"`);
	await expect(
		bridge.app('set-preferences', { microphone: USB }),
	).rejects.toThrow('does not read as a JSON object');

	await seed({ transcriptionApiKey: SECRET, addedByALaterBuild: 7 });
	await bridge.app('set-preferences', { microphone: USB });

	expect(await saved()).toEqual({
		transcriptionApiKey: SECRET,
		addedByALaterBuild: 7,
		microphone: USB,
	});
});

test('a malformed connection remains recoverable through saves and legacy adoption', async () => {
	const { bridge, deviceFile, seed, replies, logged } = await start();
	await seed({
		textConnection: { baseUrl: BASE_URL, model: 7, apiKey: SECRET },
		transcriptionApiKey: 'earlier-key',
	});
	const before = await readFile(deviceFile, 'utf8');
	for (const key of [
		{ action: 'keep' },
		{ action: 'remove' },
		{ action: 'replace', key: 'new-key' },
	]) {
		await expect(
			bridge.app('set-connection', {
				operation: 'text',
				baseUrl: BASE_URL,
				model: 'chat-model',
				key,
			}),
		).rejects.toThrow('does not read as one');
		expect(await readFile(deviceFile, 'utf8')).toBe(before);
	}
	await expect(
		bridge.app('adopt-legacy-key', {
			targets: { text: { baseUrl: BASE_URL, model: 'chat-model' } },
		}),
	).rejects.toThrow('does not read as one');
	expect(await readFile(deviceFile, 'utf8')).toBe(before);
	expect([...replies, ...logged].join('\n')).not.toContain(SECRET);
});
