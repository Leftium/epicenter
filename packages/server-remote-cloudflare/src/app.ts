import {
	oauthProvider,
	oauthProviderAuthServerMetadata,
	oauthProviderOpenIdConfigMetadata,
} from '@better-auth/oauth-provider';
import { sValidator } from '@hono/standard-validator';
import { type } from 'arktype';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { bearer } from 'better-auth/plugins/bearer';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/postgres-js';
import { cors } from 'hono/cors';
import { createFactory } from 'hono/factory';
import { describeRoute } from 'hono-openapi';
import postgres from 'postgres';
import { aiChatHandlers } from './ai-chat';
import { MAX_PAYLOAD_BYTES } from './constants';
import * as schema from './db/schema';

export { DocumentRoom } from './document-room';
// Re-export so wrangler types generates DurableObjectNamespace<WorkspaceRoom|DocumentRoom>
export { WorkspaceRoom } from './workspace-room';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Auth = ReturnType<typeof createAuth>;
type Session = Auth['$Infer']['Session'];

export type Env = {
	Bindings: Cloudflare.Env;
	Variables: {
		auth: Auth;
		user: Session['user'];
		session: Session['session'];
	};
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Shared base config for Better Auth — used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: '/auth',
	emailAndPassword: { enabled: true },
} as const;

/** Creates a fresh auth instance per-request. Hyperdrive clients must not be cached across requests. */
function createAuth(env: Env['Bindings']) {
	const sql = postgres(env.HYPERDRIVE.connectionString);
	const db = drizzle(sql, { schema });

	return betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg' }),
		baseURL: env.BASE_URL,
		secret: env.BETTER_AUTH_SECRET,
		plugins: [
			bearer(),
			jwt(),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				allowDynamicClientRegistration: false,
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
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			storeSessionInDatabase: true,
			cookieCache: {
				enabled: true,
				maxAge: 60 * 5,
				strategy: 'jwe',
			},
		},
		advanced: {
			crossSubDomainCookies: {
				enabled: true,
				domain: 'epicenter.so',
			},
		},
		trustedOrigins: [
			'https://*.epicenter.so',
			'https://epicenter.so',
			'tauri://localhost',
		],
		secondaryStorage: {
			get: (key: string) => env.SESSION_KV.get(key),
			set: (key: string, value: string, ttl?: number) =>
				env.SESSION_KV.put(key, value, {
					expirationTtl: ttl ?? 60 * 5,
				}),
			delete: (key: string) => env.SESSION_KV.delete(key),
		},
	});
}

// ---------------------------------------------------------------------------
// Factory & App
// ---------------------------------------------------------------------------

const factory = createFactory<Env>({
	initApp: (app) => {
		// CORS — skip WebSocket upgrades (101 response headers are immutable)
		app.use('*', async (c, next) => {
			if (c.req.header('upgrade') === 'websocket') return next();
			return cors({
				origin: (origin) => {
					if (!origin) return origin;
					if (origin === 'https://epicenter.so') return origin;
					if (origin.endsWith('.epicenter.so') && origin.startsWith('https://'))
						return origin;
					if (origin === 'tauri://localhost') return origin;
					return undefined;
				},
				credentials: true,
				allowHeaders: ['Content-Type', 'Authorization', 'Upgrade'],
				allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			})(c, next);
		});
		// Auth instance per-request (Hyperdrive clients must not be cached)
		app.use('*', async (c, next) => {
			c.set('auth', createAuth(c.env));
			await next();
		});
	},
});

const app = factory.createApp();

// Health
app.get(
	'/',
	describeRoute({
		description: 'Health check',
		tags: ['health'],
	}),
	(c) => c.json({ mode: 'hub', version: '0.1.0', runtime: 'cloudflare' }),
);

// Auth
app.on(
	['GET', 'POST'],
	'/auth/*',
	describeRoute({
		description: 'Better Auth handler',
		tags: ['auth'],
	}),
	(c) => c.var.auth.handler(c.req.raw),
);

// OAuth discovery
app.get(
	'/.well-known/openid-configuration/auth',
	describeRoute({
		description: 'OpenID Connect discovery metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) => oauthProviderOpenIdConfigMetadata(c.var.auth)(c.req.raw),
);
app.get(
	'/.well-known/oauth-authorization-server/auth',
	describeRoute({
		description: 'OAuth authorization server metadata',
		tags: ['auth', 'oauth'],
	}),
	(c) => oauthProviderAuthServerMetadata(c.var.auth)(c.req.raw),
);

// Auth guard for protected routes
const authGuard = factory.createMiddleware(async (c, next) => {
	const wsToken = c.req.query('token');
	const headers = wsToken
		? new Headers({ authorization: `Bearer ${wsToken}` })
		: c.req.raw.headers;

	const result = await c.var.auth.api.getSession({ headers });
	if (!result) return c.json({ error: 'Unauthorized' }, 401);

	c.set('user', result.user);
	c.set('session', result.session);
	await next();
});
app.use('/ai/*', authGuard);
app.use('/rooms/*', authGuard);
app.use('/workspaces/*', authGuard);
app.use('/documents/*', authGuard);

// AI chat
app.post(
	'/ai/chat',
	describeRoute({
		description: 'Stream AI chat completions via SSE',
		tags: ['ai'],
	}),
	...aiChatHandlers,
);

// ---------------------------------------------------------------------------
// Workspace routes — one WorkspaceRoom DO per room (gc: true)
// ---------------------------------------------------------------------------

/**
 * Helper: get a WorkspaceRoom stub for the authenticated user's room.
 *
 * ## Room key namespacing: `user:{userId}:{room}`
 *
 * We use user-scoped room keys (Google Docs model) rather than org-scoped keys
 * (Vercel/Supabase model). Each user gets their own DO instance per workspace.
 *
 * Alternatives considered:
 *
 * - **Org-scoped (`org:{orgId}:{room}`)**: Evaluated for enterprise/self-hosted.
 *   Problems: most workspaces (Whispering recordings, Entries) are personal data
 *   that shouldn't merge into a shared Y.Doc. Org-scoped would require a
 *   per-workspace `scope` flag anyway, adding complexity without simplifying.
 *
 * - **Org-scoped with personal sub-scope (`org:{orgId}:user:{userId}:{room}`)**:
 *   Embeds org management in the app. For self-hosted enterprise, the deployment
 *   itself IS the org boundary (like GitLab, Outline, Mattermost), so org tables
 *   and Better Auth organization plugin are unnecessary overhead.
 *
 * Current scheme keeps the app auth-simple ("user has account, user accesses
 * rooms") and works for both cloud and self-hosted without org infrastructure.
 * When sharing is needed, it follows the Google Docs pattern: the owner's room
 * key stays the same, an ACL table grants access to other users, and auth
 * middleware checks "is this user the owner OR in the ACL?"
 *
 * Multi-tenant cloud isolation (if needed later) is a platform-layer concern—
 * a tenant prefix added at the routing layer, not embedded in the app's data model.
 */
function getWorkspaceStub(c: {
	var: { user: { id: string } };
	env: Cloudflare.Env;
	req: { param: (k: string) => string };
}) {
	const roomKey = `user:${c.var.user.id}:${c.req.param('room')}` as const;
	return c.env.WORKSPACE_ROOM.get(c.env.WORKSPACE_ROOM.idFromName(roomKey));
}

/** Helper: get a DocumentRoom stub for the authenticated user's room. See {@link getWorkspaceStub} for namespacing rationale. */
function getDocumentStub(c: {
	var: { user: { id: string } };
	env: Cloudflare.Env;
	req: { param: (k: string) => string };
}) {
	const roomKey = `user:${c.var.user.id}:${c.req.param('room')}` as const;
	return c.env.DOCUMENT_ROOM.get(c.env.DOCUMENT_ROOM.idFromName(roomKey));
}

app.get(
	'/workspaces/:room',
	describeRoute({
		description: 'Get workspace doc or upgrade to WebSocket',
		tags: ['workspaces'],
	}),
	async (c) => {
		const stub = getWorkspaceStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			return stub.fetch(c.req.raw);
		}

		const update = await stub.getDoc();
		return new Response(update, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/workspaces/:room',
	describeRoute({
		description: 'Sync workspace doc',
		tags: ['workspaces'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const stub = getWorkspaceStub(c);
		const diff = await stub.sync(body);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

// /rooms/:room — temporary alias for /workspaces/:room during client rollout
app.get(
	'/rooms/:room',
	describeRoute({
		description: 'Get workspace doc or upgrade to WebSocket (rooms alias)',
		tags: ['rooms'],
	}),
	async (c) => {
		const stub = getWorkspaceStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			return stub.fetch(c.req.raw);
		}

		const update = await stub.getDoc();
		return new Response(update, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/rooms/:room',
	describeRoute({
		description: 'Sync workspace doc (rooms alias)',
		tags: ['rooms'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const stub = getWorkspaceStub(c);
		const diff = await stub.sync(body);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

// ---------------------------------------------------------------------------
// Document routes — one DocumentRoom DO per room (gc: false, snapshots)
// ---------------------------------------------------------------------------

app.get(
	'/documents/:room',
	describeRoute({
		description: 'Get document doc or upgrade to WebSocket',
		tags: ['documents'],
	}),
	async (c) => {
		const stub = getDocumentStub(c);

		if (c.req.header('upgrade') === 'websocket') {
			return stub.fetch(c.req.raw);
		}

		const update = await stub.getDoc();
		return new Response(update, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/documents/:room',
	describeRoute({
		description: 'Sync document doc',
		tags: ['documents'],
	}),
	async (c) => {
		const body = new Uint8Array(await c.req.arrayBuffer());
		if (body.byteLength > MAX_PAYLOAD_BYTES) {
			return c.body('Payload too large', 413);
		}

		const stub = getDocumentStub(c);
		const diff = await stub.sync(body);

		if (!diff) return c.body(null, 304);
		return new Response(diff, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

// Snapshot endpoints for DocumentRoom
app.post(
	'/documents/:room/snapshots',
	describeRoute({
		description: 'Save a document snapshot',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('json', type({ label: 'string | null' })),
	async (c) => {
		const stub = getDocumentStub(c);
		const { label } = c.req.valid('json');
		const result = await stub.saveSnapshot(label ?? undefined);
		return c.json(result);
	},
);

app.get(
	'/documents/:room/snapshots',
	describeRoute({
		description: 'List document snapshots',
		tags: ['documents', 'snapshots'],
	}),
	async (c) => {
		const stub = getDocumentStub(c);
		const snapshots = await stub.listSnapshots();
		return c.json(snapshots);
	},
);

app.get(
	'/documents/:room/snapshots/:id',
	describeRoute({
		description: 'Get a document snapshot by ID',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('param', type({ room: 'string', id: 'string.numeric' })),
	async (c) => {
		const stub = getDocumentStub(c);
		const { id } = c.req.valid('param');
		const data = await stub.getSnapshot(Number(id));
		if (!data) return c.body('Snapshot not found', 404);
		return new Response(data, {
			headers: { 'content-type': 'application/octet-stream' },
		});
	},
);

app.post(
	'/documents/:room/snapshots/:id/apply',
	describeRoute({
		description:
			'Apply a past snapshot state into the current document (CRDT forward-merge)',
		tags: ['documents', 'snapshots'],
	}),
	sValidator('param', type({ room: 'string', id: 'string.numeric' })),
	async (c) => {
		const stub = getDocumentStub(c);
		const { id } = c.req.valid('param');
		const ok = await stub.applySnapshot(Number(id));
		if (!ok) return c.json({ error: 'Snapshot not found' }, 404);
		return c.json({ ok: true });
	},
);

export default app;
