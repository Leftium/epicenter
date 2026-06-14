/**
 * Web Audio Sound Service Tests
 *
 * Verifies that feedback sounds use short-lived Web Audio playback rather than
 * persistent media elements. These tests protect the macOS media-key fix and
 * the sleep/wake cleanup behavior.
 *
 * Key behaviors:
 * - Creates and closes a fresh AudioContext per playback
 * - Resumes suspended contexts before decoding
 * - Skips playback when the browser service says sounds should not play
 * - Does not cache decoded buffers across closed contexts
 */
import { expect, test } from 'bun:test';
import {
	createWebAudioPlaySoundService,
	type WebAudioEnvironment,
} from './web-audio';

const soundSources = {
	'manual-start': '/manual-start.mp3',
	'manual-cancel': '/manual-cancel.mp3',
	'manual-stop': '/manual-stop.mp3',
	'vad-start': '/vad-start.mp3',
	'vad-capture': '/vad-capture.mp3',
	'vad-stop': '/vad-stop.mp3',
	transcriptionComplete: '/transcription-complete.mp3',
	transformationComplete: '/transformation-complete.mp3',
};

type SetupOptions = {
	fetchOk?: boolean;
	shouldPlay?: boolean;
	state?: AudioContextState;
};

function setup({
	fetchOk = true,
	shouldPlay = true,
	state = 'running',
}: SetupOptions = {}) {
	const events: string[] = [];
	let sourceEnded: (() => void) | null = null;

	const createContext = (): ReturnType<
		WebAudioEnvironment['createAudioContext']
	> => {
		events.push('context:create');
		return {
			state,
			destination: {} as AudioDestinationNode,
			resume: async () => {
				events.push('context:resume');
			},
			close: async () => {
				events.push('context:close');
			},
			decodeAudioData: async () => {
				events.push('context:decode');
				return {} as AudioBuffer;
			},
			createBufferSource: () => {
				events.push('source:create');
				return {
					buffer: null,
					connect: () => {
						events.push('source:connect');
						return {} as AudioNode;
					},
					get onended() {
						return sourceEnded;
					},
					set onended(handler) {
						sourceEnded = handler;
					},
					start: () => {
						events.push('source:start');
						sourceEnded?.();
					},
				};
			},
		};
	};

	const environment: WebAudioEnvironment = {
		createAudioContext: createContext,
		fetch: async (input) => {
			events.push(`fetch:${input}`);
			return {
				ok: fetchOk,
				statusText: fetchOk ? 'OK' : 'Not Found',
				arrayBuffer: async () => {
					events.push('fetch:arrayBuffer');
					return new ArrayBuffer(8);
				},
			};
		},
	};

	const service = createWebAudioPlaySoundService({
		environment,
		shouldPlay: () => shouldPlay,
		soundSources,
	});

	return { events, service };
}

test('playSound decodes, starts, and closes a fresh AudioContext', async () => {
	const { events, service } = setup();

	const result = await service.playSound('manual-start');

	expect(result.error).toBeNull();
	expect(events).toEqual([
		'context:create',
		'fetch:/manual-start.mp3',
		'fetch:arrayBuffer',
		'context:decode',
		'source:create',
		'source:connect',
		'source:start',
		'context:close',
	]);
});

test('playSound resumes a suspended AudioContext before decoding', async () => {
	const { events, service } = setup({ state: 'suspended' });

	const result = await service.playSound('manual-stop');

	expect(result.error).toBeNull();
	expect(events.slice(0, 3)).toEqual([
		'context:create',
		'context:resume',
		'fetch:/manual-stop.mp3',
	]);
});

test('playSound skips playback when shouldPlay returns false', async () => {
	const { events, service } = setup({ shouldPlay: false });

	const result = await service.playSound('transcriptionComplete');

	expect(result.error).toBeNull();
	expect(events).toEqual([]);
});

test('playSound closes the AudioContext when fetching fails', async () => {
	const { events, service } = setup({ fetchOk: false });

	const result = await service.playSound('vad-stop');

	expect(result.error?.name).toBe('Play');
	expect(events).toEqual([
		'context:create',
		'fetch:/vad-stop.mp3',
		'context:close',
	]);
});

test('playSound fetches and decodes again for repeat playback', async () => {
	const { events, service } = setup();

	await service.playSound('transformationComplete');
	await service.playSound('transformationComplete');

	expect(events.filter((event) => event === 'context:create')).toHaveLength(2);
	expect(events.filter((event) => event === 'context:decode')).toHaveLength(2);
	expect(events.filter((event) => event === 'context:close')).toHaveLength(2);
});
