import { isTauri } from '@tauri-apps/api/core';
import { createPlaySoundServiceDesktop } from './desktop';
import { createPlaySoundServiceWeb } from './web';

export type { PlaySoundService, SoundError } from './types';

export const PlaySoundServiceLive = isTauri()
	? createPlaySoundServiceDesktop()
	: createPlaySoundServiceWeb();
