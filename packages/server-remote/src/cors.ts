import { cors } from 'hono/cors';
import { createMiddleware } from 'hono/factory';
import type { SharedEnv } from './types';

/**
 * CORS middleware that skips WebSocket upgrades.
 *
 * Hono's CORS middleware modifies response headers, which conflicts with
 * the immutable 101 WebSocket upgrade response.
 */
export const corsMiddleware = createMiddleware<SharedEnv>(async (c, next) => {
	if (c.req.header('upgrade') === 'websocket') return next();
	return cors({
		origin: (origin) => origin,
		credentials: true,
		allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
		allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
	})(c, next);
});
