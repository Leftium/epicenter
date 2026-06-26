import { AnthropicCompletionServiceLive } from './anthropic';
import { GoogleCompletionServiceLive } from './google';

export type { CompletionService } from './types';
export {
	AnthropicCompletionServiceLive as anthropic,
	GoogleCompletionServiceLive as google,
};
