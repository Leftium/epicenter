import { Ok, tryAsync } from 'wellcrafted/result';
import type { WhisperingSoundNames } from '$lib/constants/sounds';
import { type PlaySoundService, SoundError } from './types';

type SoundSources = Record<WhisperingSoundNames, string>;

async function closeContext(context: AudioContext) {
	try {
		await context.close();
	} catch {
		// Best effort cleanup. Playback success should not become a sound failure
		// because the browser refused to close an already-ending context.
	}
}

async function playSoundSource(soundSource: string) {
	const context = new AudioContext();
	try {
		// A fresh context can start suspended under the browser autoplay policy
		// (e.g. Safari cold start). These cues always follow a user action, so
		// resuming here is safe and keeps the sound audible.
		if (context.state === 'suspended') {
			await context.resume();
		}

		const response = await fetch(soundSource);
		if (!response.ok) {
			throw new Error(`Failed to fetch sound: ${response.statusText}`);
		}
		const audioBuffer = await context.decodeAudioData(
			await response.arrayBuffer(),
		);

		const source = context.createBufferSource();
		source.buffer = audioBuffer;
		source.connect(context.destination);

		await new Promise<void>((resolve) => {
			// Close once the clip ends, but bound the wait: onended is not
			// guaranteed to fire if the context is interrupted, and the finally
			// must always close the context so the app never lingers as the OS
			// media target.
			const fallback = setTimeout(resolve, audioBuffer.duration * 1000 + 250);
			source.onended = () => {
				clearTimeout(fallback);
				resolve();
			};
			source.start();
		});
	} finally {
		await closeContext(context);
	}
}

export function createWebAudioPlaySoundService({
	shouldPlay = () => true,
	soundSources,
}: {
	shouldPlay?: () => boolean;
	soundSources: SoundSources;
}): PlaySoundService {
	return {
		playSound: async (soundName) => {
			if (!shouldPlay()) {
				return Ok(undefined);
			}

			return tryAsync({
				try: () => playSoundSource(soundSources[soundName]),
				catch: (error) => SoundError.Play({ cause: error }),
			});
		},
	};
}
