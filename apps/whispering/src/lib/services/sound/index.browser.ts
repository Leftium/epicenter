import { Ok } from 'wellcrafted/result';
import { audioElements } from './assets';
import type { PlaySoundService } from './types';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive: PlaySoundService = {
	playSound: async (soundName) => {
		if (!document.hidden) {
			await audioElements[soundName].play();
			return Ok(undefined);
		}
		return Ok(undefined);
	},
};
