import { extractErrorMessage } from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import type { PlaySoundService } from '.';
import { audioElements } from './assets';
import { SoundError } from './types';

export function createPlaySoundServiceDesktop(): PlaySoundService {
	return {
		playSound: async (soundName) =>
			tryAsync({
				try: async () => {
					await audioElements[soundName].play();
				},
				catch: (error) =>
					SoundError.Play({
						message: `Failed to play sound: ${extractErrorMessage(error)}`,
					}),
			}),
	};
}
