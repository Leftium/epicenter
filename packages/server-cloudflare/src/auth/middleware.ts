import { extractBearerToken } from '@epicenter/sync-core';
import { createMiddleware } from 'hono/factory';
import type { Bindings, Variables } from '../worker';
import { createAuth } from './better-auth';

export function createAuthMiddleware() {
	return createMiddleware<{ Bindings: Bindings; Variables: Variables }>(
		async (c, next) => {
			// WebSocket: token in query string. HTTP: token in Authorization header.
			const token =
				c.req.query('token') ??
				extractBearerToken(c.req.header('authorization'));

			if (!token) return c.json({ error: 'Unauthorized' }, 401);

			const auth = createAuth(c.env);
			const result = await auth.api.getSession({
				headers: new Headers({ authorization: `Bearer ${token}` }),
			});

			if (!result) return c.json({ error: 'Unauthorized' }, 401);

			c.set('user', result.user);
			c.set('session', result.session);
			await next();
		},
	);
}
