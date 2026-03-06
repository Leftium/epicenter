import { oauthProvider } from '@better-auth/oauth-provider';
import type { AuthWithOAuth } from './types';
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';

// ---------------------------------------------------------------------------
// Auth mode types
// ---------------------------------------------------------------------------

export type StandaloneAuthConfig =
	| { mode: 'none' }
	| { mode: 'token'; token: string }
	| {
			mode: 'betterAuth';
			/** Database connection (bun:sqlite Database or pg Pool). */
			database: unknown;
			/** Secret for signing session tokens. Falls back to BETTER_AUTH_SECRET or AUTH_SECRET env. */
			secret?: string;
			/** Trusted origins for CORS/CSRF validation. */
			trustedOrigins?: string[];
			/** Social OAuth provider credentials. */
			socialProviders?: Record<
				string,
				{ clientId: string; clientSecret: string }
			>;
	  };

// ---------------------------------------------------------------------------
// Auth instance creation
// ---------------------------------------------------------------------------

/**
 * Create an Auth instance for the standalone adapter based on the configured mode.
 *
 * - `none`: all requests pass through, getSession always returns a placeholder
 * - `token`: pre-shared Bearer secret, getSession validates against it
 * - `betterAuth`: full Better Auth with database
 */
type AdminSeeder = {
	api: {
		signUpEmail: (opts: {
			body: { email: string; password: string; name: string };
		}) => Promise<unknown>;
	};
};

export function createStandaloneAuth(config: StandaloneAuthConfig): {
	auth: AuthWithOAuth;
	betterAuth?: AdminSeeder;
} {
	switch (config.mode) {
		case 'none':
			return { auth: createNoneAuth() };
		case 'token':
			return { auth: createTokenAuth(config.token) };
		case 'betterAuth':
			return createBetterAuthInstance(config);
	}
}

// ---------------------------------------------------------------------------
// None mode
// ---------------------------------------------------------------------------

function createNoneAuth() {
	return {
		handler: () => new Response('Not Found', { status: 404 }),
		api: {
			getSession: async () => ({
				user: { id: 'anonymous', name: 'Anonymous', email: '' },
				session: { id: 'anonymous' },
			}),
		},
	} as unknown as AuthWithOAuth;
}

// ---------------------------------------------------------------------------
// Token mode
// ---------------------------------------------------------------------------

function createTokenAuth(token: string) {
	const handler = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);

		// Stub: GET /auth/get-session — validates the token and returns
		// the canonical token-user shape that sidecars depend on.
		if (url.pathname === '/auth/get-session' && request.method === 'GET') {
			const authHeader = request.headers.get('authorization');
			const bearerToken = authHeader?.startsWith('Bearer ')
				? authHeader.slice(7)
				: null;

			if (bearerToken === token) {
				return Response.json({
					user: { id: 'token-user', name: 'Token User' },
				});
			}
			return Response.json({ error: 'Unauthorized' }, { status: 401 });
		}

		return new Response('Not Found', { status: 404 });
	};

	return {
		handler,
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const authHeader = headers.get('authorization');
				const bearerToken = authHeader?.startsWith('Bearer ')
					? authHeader.slice(7)
					: null;

				// Also check query param (normalized by auth middleware for WS)
				if (bearerToken === token) {
					return {
						user: { id: 'token-user', name: 'Token User', email: '' },
						session: { id: 'token-session' },
					};
				}
				return null;
			},
		},
	} as unknown as AuthWithOAuth;
}

// ---------------------------------------------------------------------------
// Better Auth mode
// ---------------------------------------------------------------------------

function createBetterAuthInstance(config: {
	database: unknown;
	secret?: string;
	trustedOrigins?: string[];
	socialProviders?: Record<string, { clientId: string; clientSecret: string }>;
}) {
	const auth = betterAuth({
		basePath: '/auth',
		emailAndPassword: { enabled: true },
		database: config.database as Parameters<typeof betterAuth>[0]['database'],
		secret: config.secret,
		trustedOrigins: config.trustedOrigins,
		socialProviders: config.socialProviders,
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: true,
				trustedClients: [
					{
						clientId: 'epicenter-desktop',
						name: 'Epicenter Desktop',
						type: 'native',
						redirectUrls: ['tauri://localhost/auth/callback'],
						skipConsent: true,
						metadata: {},
					},
					{
						clientId: 'epicenter-mobile',
						name: 'Epicenter Mobile',
						type: 'native',
						redirectUrls: ['epicenter://auth/callback'],
						skipConsent: true,
						metadata: {},
					},
				],
			}),
		],
	});

	return { auth: auth as unknown as AuthWithOAuth, betterAuth: auth };
}

/**
 * Seed an admin user if ADMIN_EMAIL and ADMIN_PASSWORD env vars are set.
 * Silently no-ops if the user already exists.
 */
export async function seedAdminIfNeeded(auth: AdminSeeder) {
	const email = process.env.ADMIN_EMAIL;
	const password = process.env.ADMIN_PASSWORD;
	if (!email || !password) return;

	try {
		await auth.api.signUpEmail({ body: { email, password, name: 'Admin' } });
	} catch {
		// Already exists or signup disabled — fine
	}
}
