import { tryAsync } from 'wellcrafted/result';
import { audioElements } from './assets';
import { SoundError, type PlaySoundService } from './types';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive = {
	playSound: async (soundName) =>
		tryAsync({
			try: async () => {
				await audioElements[soundName].play();
			},
			catch: (error) => SoundError.Play({ cause: error }),
		}),
} satisfies PlaySoundService;
