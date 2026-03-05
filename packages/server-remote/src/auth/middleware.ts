import { createMiddleware } from 'hono/factory';
import type { AuthInstance, SharedEnv } from '../types';

/** Creates auth middleware that validates sessions via the provided Better Auth instance. */
export function createAuthMiddleware(auth: AuthInstance) {
	return createMiddleware<SharedEnv>(async (c, next) => {
		// WebSocket clients pass the token as a query param (no Authorization
		// header on upgrade requests). Normalise into a Bearer header so
		// Better Auth's bearer() plugin handles extraction uniformly.
		const wsToken = c.req.query('token');
		const headers = wsToken
			? new Headers({ authorization: `Bearer ${wsToken}` })
			: c.req.raw.headers;

		const result = await auth.api.getSession({ headers });
		if (!result) return c.json({ error: 'Unauthorized' }, 401);

		c.set('user', result.user);
		c.set('session', result.session);
		await next();
	});
}
