import { createFactory } from 'hono/factory';
import type { Env } from './types';

export const factory = createFactory<Env>();
