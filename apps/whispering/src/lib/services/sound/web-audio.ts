import { Ok, tryAsync } from 'wellcrafted/result';
import { type PlaySoundService, SoundError } from './types';

type SoundName = Parameters<PlaySoundService['playSound']>[0];
type SoundSources = Record<SoundName, string>;

type SoundAudioSource = Pick<
	AudioBufferSourceNode,
	'buffer' | 'connect' | 'onended' | 'start'
>;

export type WebAudioEnvironment = {
	createAudioContext: () => Pick<
		AudioContext,
		'close' | 'decodeAudioData' | 'destination' | 'resume' | 'state'
	> & {
		createBufferSource: () => SoundAudioSource;
	};
	fetch: (
		input: string,
	) => Promise<Pick<Response, 'arrayBuffer' | 'ok' | 'statusText'>>;
};

const defaultEnvironment: WebAudioEnvironment = {
	createAudioContext: () => new AudioContext(),
	fetch: (input) => fetch(input),
};

async function closeContext(
	context: ReturnType<WebAudioEnvironment['createAudioContext']>,
) {
	try {
		await context.close();
	} catch {
		// Best effort cleanup. Playback success should not become a sound failure
		// because the browser refused to close an already-ending context.
	}
}

async function decodeSound(
	environment: WebAudioEnvironment,
	context: ReturnType<WebAudioEnvironment['createAudioContext']>,
	soundSource: string,
) {
	const response = await environment.fetch(soundSource);
	if (!response.ok) {
		throw new Error(`Failed to fetch sound: ${response.statusText}`);
	}
	return context.decodeAudioData(await response.arrayBuffer());
}

async function playSoundSource({
	environment,
	soundSource,
}: {
	environment: WebAudioEnvironment;
	soundSource: string;
}) {
	const context = environment.createAudioContext();
	try {
		if (context.state === 'suspended') {
			await context.resume();
		}

		const audioBuffer = await decodeSound(environment, context, soundSource);
		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);

		await new Promise<void>((resolve) => {
			source.onended = () => resolve();
			source.start();
		});
	} finally {
		await closeContext(context);
	}
}

export function createWebAudioPlaySoundService({
	environment = defaultEnvironment,
	shouldPlay = () => true,
	soundSources,
}: {
	environment?: WebAudioEnvironment;
	shouldPlay?: () => boolean;
	soundSources: SoundSources;
}): PlaySoundService {
	return {
		playSound: async (soundName) => {
			if (!shouldPlay()) {
				return Ok(undefined);
			}

			return tryAsync({
				try: () =>
					playSoundSource({
						environment,
						soundSource: soundSources[soundName],
					}),
				catch: (error) => SoundError.Play({ cause: error }),
			});
		},
	};
}
