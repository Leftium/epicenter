import { createFactory } from 'hono/factory';
import type { AppEnv } from './env';

export const factory = createFactory<AppEnv>();
