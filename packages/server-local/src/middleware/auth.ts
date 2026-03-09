import { createMiddleware } from 'hono/factory';

export type AuthUser = { id: string; email: string; name?: string };

export type AuthConfig =
	| { mode: 'none' }
	| { mode: 'token'; token: string }
	| { mode: 'remote'; hubUrl: string; cacheTtlMs?: number };

type CacheEntry = {
	user: AuthUser | null;
	cachedAt: number;
};

function extractBearerToken(
	authorization: string | undefined,
): string | undefined {
	if (!authorization?.startsWith('Bearer ')) return undefined;
	return authorization.slice(7);
}

/**
 * Create a Hono middleware that authenticates requests based on the given config.
 *
 * - `none`: no-op, all requests pass through
 * - `token`: pre-shared Bearer token
 * - `remote`: delegates to hub's `/auth/get-session` endpoint with TTL cache
 *
 * Sets `c.set('user', user)` when authenticated. Routes access via `c.get('user')`.
 * Skips auth for `GET /` (health check).
 */
export function createAuthMiddleware(config: AuthConfig) {
	if (config.mode === 'none') {
		return createMiddleware(async (_c, next) => next());
	}

	if (config.mode === 'token') {
		return createMiddleware(async (c, next) => {
			if (c.req.path === '/') return next();
			const token = extractBearerToken(
				c.req.header('authorization') ?? undefined,
			);
			if (token !== config.token) {
				return c.json({ error: 'Unauthorized: Invalid token' }, 401);
			}
			return next();
		});
	}

	// mode: 'remote'
	const { hubUrl } = config;
	const cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
	const cache = new Map<string, CacheEntry>();

	async function validateSession(token: string): Promise<AuthUser | null> {
		const cached = cache.get(token);
		if (cached && Date.now() - cached.cachedAt < cacheTtlMs) {
			return cached.user;
		}

		try {
			const response = await fetch(`${hubUrl}/auth/get-session`, {
				headers: { Authorization: `Bearer ${token}` },
			});

			if (!response.ok) {
				cache.set(token, { user: null, cachedAt: Date.now() });
				return null;
			}

			const data = (await response.json()) as {
				user?: { id: string; email: string; name?: string };
			};

			if (!data.user) {
				cache.set(token, { user: null, cachedAt: Date.now() });
				return null;
			}

			const user: AuthUser = {
				id: data.user.id,
				email: data.user.email,
				name: data.user.name,
			};
			cache.set(token, { user, cachedAt: Date.now() });
			return user;
		} catch {
			// Hub unreachable — use stale cache if available
			if (cached?.user) return cached.user;
			return null;
		}
	}

	return createMiddleware(async (c, next) => {
		if (c.req.path === '/') return next();
		const token = extractBearerToken(
			c.req.header('authorization') ?? undefined,
		);
		if (!token) return c.json({ error: 'Unauthorized' }, 401);

		const user = await validateSession(token);
		if (!user) return c.json({ error: 'Unauthorized' }, 401);

		c.set('user', user);
		return next();
	});
}
