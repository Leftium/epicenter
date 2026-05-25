import { isTauri } from '@tauri-apps/api/core';
import { createHttpServiceDesktop } from './desktop';
import { createHttpServiceWeb } from './web';

export { customFetch } from './tauri-fetch';
// Re-export both types and factory functions
export type {
	ConnectionError,
	HttpService,
	ParseError,
	ResponseError,
} from './types';
export { HttpError } from './types';

export const HttpServiceLive = isTauri()
	? createHttpServiceDesktop()
	: createHttpServiceWeb();
