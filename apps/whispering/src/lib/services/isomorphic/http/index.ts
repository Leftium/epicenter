import { createHttpServiceDesktop } from './desktop';
import { createHttpServiceWeb } from './web';

// Re-export both types and factory functions
export type { HttpService } from './types';
export type { ConnectionError, ResponseError, ParseError } from './types';
export { HttpError } from './types';

export const HttpServiceLive = window.__TAURI_INTERNALS__
	? createHttpServiceDesktop()
	: createHttpServiceWeb();
