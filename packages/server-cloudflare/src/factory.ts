import { createFactory } from 'hono/factory';
import type { AppEnv } from './worker';

export const factory = createFactory<AppEnv>();
