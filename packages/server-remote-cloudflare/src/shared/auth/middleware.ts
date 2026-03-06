import { AuthError } from '../errors';
import { factory } from '../factory';

/** Auth middleware that validates sessions via Better Auth on the context. */
export const authMiddleware = factory.createMiddleware(async (c, next) => {
	// WebSocket clients pass the token as a query param (no Authorization
	// header on upgrade requests). Normalise into a Bearer header so
	// Better Auth's bearer() plugin handles extraction uniformly.
	const wsToken = c.req.query('token');
	const headers = wsToken
		? new Headers({ authorization: `Bearer ${wsToken}` })
		: c.req.raw.headers;

	const result = await c.var.auth.api.getSession({ headers });
	if (!result) return c.json(AuthError.Unauthorized(), 401);

	c.set('user', result.user);
	c.set('session', result.session);
	await next();
});
