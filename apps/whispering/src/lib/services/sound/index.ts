import { createPlaySoundServiceDesktop } from './desktop';
import { createPlaySoundServiceWeb } from './web';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive = window.__TAURI_INTERNALS__
	? createPlaySoundServiceDesktop()
	: createPlaySoundServiceWeb();
