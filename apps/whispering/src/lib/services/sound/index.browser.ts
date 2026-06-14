import { soundSources } from './assets';
import { createWebAudioPlaySoundService } from './web-audio';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive = createWebAudioPlaySoundService({
	shouldPlay: () => !document.hidden,
	soundSources,
});
