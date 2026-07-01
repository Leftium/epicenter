/**
 * Browser runtime client for Whispering. Consumed everywhere through the
 * `#platform/whispering` seam; see `whispering.active.ts` for what
 * `openWhispering` builds. The web default transcription service is OpenAI.
 */

import { openWhispering } from './whispering.active';

export const whispering = openWhispering('OpenAI');
