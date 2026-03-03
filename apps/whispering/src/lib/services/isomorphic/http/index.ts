import { createHttpServiceDesktop } from './desktop';
import { createHttpServiceWeb } from './web';

// Re-export both types and factory functions
export type {
	ConnectionError,
	HttpService,
	ParseError,
	ResponseError,
} from './types';
export { HttpError } from './types';
export { customFetch } from './tauri-fetch';

export const HttpServiceLive = window.__TAURI_INTERNALS__
	? createHttpServiceDesktop()
	: createHttpServiceWeb();
