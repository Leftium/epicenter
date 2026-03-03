import { createTextServiceDesktop } from './desktop';
import { createTextServiceWeb } from './web';

export type { TextService, TextError } from './types';

export const TextServiceLive = window.__TAURI_INTERNALS__
	? createTextServiceDesktop()
	: createTextServiceWeb();
