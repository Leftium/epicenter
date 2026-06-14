import { soundSources } from './assets';
import type { PlaySoundService } from './types';
import { createWebAudioPlaySoundService } from './web-audio';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive: PlaySoundService =
	createWebAudioPlaySoundService({
		shouldPlay: () => !document.hidden,
		soundSources,
	});
