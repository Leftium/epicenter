import { Autumn } from 'autumn-js';

/**
 * Create an Autumn SDK client from worker env bindings.
 *
 * Stateless—safe to create per-request. No connection pooling needed.
 *
 * @example
 * ```ts
 * const autumn = createAutumn(c.env);
 * const { allowed } = await autumn.check({ ... });
 * ```
 */
export function createAutumn(env: { AUTUMN_SECRET_KEY: string }) {
	return new Autumn({ secretKey: env.AUTUMN_SECRET_KEY });
}
