import { extractBearerToken } from '@epicenter/sync-core';
import { factory } from '../factory';

export function createAuthMiddleware() {
	return factory.createMiddleware(async (c, next) => {
		// WebSocket: token in query string. HTTP: token in Authorization header.
		const token =
			c.req.query('token') ??
			extractBearerToken(c.req.header('authorization'));

		if (!token) return c.json({ error: 'Unauthorized' }, 401);

		const auth = c.get('auth');
		const result = await auth.api.getSession({
			headers: new Headers({ authorization: `Bearer ${token}` }),
		});

		if (!result) return c.json({ error: 'Unauthorized' }, 401);

		// Reject sessions that were revoked but still linger in KV
		// during the ~60s eventual-consistency propagation window.
		const revoked = await c.env.SESSION_KV.get(
			`revoked:${result.session.token}`,
		);
		if (revoked) return c.json({ error: 'Unauthorized' }, 401);

		c.set('user', result.user);
		c.set('session', result.session);
		await next();
	});
}
