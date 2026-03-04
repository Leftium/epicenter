import { openapi } from '@elysiajs/openapi';
import { createTokenGuardPlugin, listenWithFallback } from '@epicenter/server-elysia';
import { createWsSyncPlugin } from '@epicenter/server-elysia/sync';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createAIPlugin } from './ai';
import {
	type AuthPluginConfig,
	createAuthPlugin,
	createBetterAuth,
} from './auth';
import { createProxyPlugin } from './proxy';

export { DEFAULT_PORT, listenWithFallback } from '@epicenter/server-elysia';

/**
 * Auth configuration for the remote server.
 *
 * The remote server is the **source** of authentication — it either issues
 * sessions (Better Auth) or defines the shared token that all tiers accept.
 * Compare with {@link LocalAuthConfig} in `@epicenter/server-local`, which is
 * always a **consumer** of auth (validating tokens issued here or delegating
 * back to this server).
 *
 * Three mutually exclusive modes:
 *
 * - **`none`** — No authentication. All requests are accepted. Use for local
 *   development or when the server is only reachable from trusted networks.
 *
 * - **`token`** — A single pre-shared secret. Everyone who knows the token can
 *   access the server, but there are no user accounts — all authenticated
 *   requests are treated as the same anonymous identity. Use for enterprise
 *   self-hosted deployments where one team shares a server and doesn't need
 *   per-user identity. The token is sent as `Authorization: Bearer <token>`.
 *   Local servers use the same token (`LocalAuthConfig.mode: 'token'`).
 *
 * - **`betterAuth`** — Full user account management via Better Auth. Provides
 *   sign-up, sign-in, sessions, and social OAuth (GitHub, Google, etc.).
 *   Requires a database. Use for cloud deployments where per-user identity,
 *   audit trails, and OAuth integrations (e.g. GitHub, Spotify) are needed.
 *   Local servers can delegate to this via `LocalAuthConfig.mode: 'remote'`.
 *
 * @example
 * ```typescript
 * // No auth (development)
 * createRemoteServer({ auth: { mode: 'none' } })
 *
 * // Shared token (enterprise self-hosted)
 * createRemoteServer({ auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! } })
 *
 * // Full user accounts (cloud)
 * createRemoteServer({
 *   auth: {
 *     mode: 'betterAuth',
 *     database: new Database('auth.db'),
 *     secret: 'my-secret',
 *     socialProviders: { github: { clientId: '...', clientSecret: '...' } },
 *   },
 * })
 * ```
 */
export type RemoteAuthConfig =
	| {
			/** No authentication — all requests are accepted. */
			mode: 'none';
	  }
	| {
			/**
			 * Pre-shared token authentication.
			 *
			 * Everyone on the server is viewed as the same anonymous authenticated user.
			 * There are no user accounts, no sign-up flow, and no OAuth integrations.
			 * The token is sent as `Authorization: Bearer <token>` on every request.
			 *
			 * To rotate the token, change the value and restart the server.
			 * All clients will need to update their stored token.
			 */
			mode: 'token';

			/** The pre-shared secret. Typically set via an environment variable. */
			token: string;
	  }
	| ({
			/**
			 * Full user account management via Better Auth.
			 *
			 * Provides sign-up/sign-in, session management, Bearer token support,
			 * and social OAuth providers. Requires a database for session storage.
			 * This is the only mode that supports per-user identity and OAuth
			 * integrations (GitHub, Spotify, Google, etc.).
			 */
			mode: 'betterAuth';
	  } & AuthPluginConfig);

export type RemoteServerConfig = {
	/**
	 * Preferred port to listen on.
	 *
	 * Falls back to the `PORT` environment variable, then 3913.
	 * If the port is taken, the OS assigns an available one.
	 */
	port?: number;

	/**
	 * Authentication mode.
	 *
	 * Controls how the remote server authenticates incoming requests.
	 * Defaults to `{ mode: 'none' }` when omitted (open mode, no auth).
	 *
	 * @see {@link RemoteAuthConfig} for the three available modes.
	 */
	auth?: RemoteAuthConfig;

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		/**
		 * Custom auth for sync endpoints. When omitted, sync auth is
		 * auto-wired from the top-level `auth` config:
		 * - `none` → no sync auth
		 * - `token` → token comparison
		 * - `betterAuth` → session validation via `auth.api.getSession()`
		 */
		verifyToken?: (token: string) => boolean | Promise<boolean>;

		/** Called when a new sync room is created on demand. */
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

		/** Called when an idle sync room is evicted after all clients disconnect. */
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};

/**
 * Create an Epicenter remote server.
 *
 * The remote server is the top tier in the three-tier topology: one cloud/hosted instance
 * shared by all devices. Local sidecar servers (one per device) connect outward
 * to the remote server for cross-device Yjs sync and AI requests.
 *
 *   Remote (cloud, one instance)
 *   +--------------------------------------------------+
 *   |  - Better Auth: sessions, JWT, JWKS              |
 *   |  - AI proxy: API keys in env vars, never leave   |
 *   |  - AI streaming: SSE chat completions            |
 *   |  - Yjs relay: ephemeral Y.Docs, pure WebSocket   |
 *   +--------------------------------------------------+
 *          |  cross-device Yjs sync      |  AI requests
 *          v                             v
 *   Local Server A (Device 1)    Local Server B (Device 2)
 *
 * What the remote server DOES:
 * - Issues and validates sessions via Better Auth (`/auth/*`)
 * - Proxies AI provider API keys so they never leave the remote server (`/proxy/*`)
 * - Streams AI completions from all providers via SSE (`/ai/chat`)
 * - Relays Yjs updates between clients via WebSocket rooms (`/rooms/*`)
 *
 * What the remote server does NOT do:
 * - Workspace CRUD (no configs, tables, or file projections)
 * - Extension or action execution
 * - Persistence of any kind — Y.Docs on the remote server are ephemeral; they are
 *   created on demand when the first client joins a room and destroyed when
 *   the last client leaves. The local server holds the persisted source of truth.
 *
 * Cross-device sync (Phase 4, not yet wired):
 * Local servers will connect to the remote server as Yjs clients (via `--remote` flag),
 * so that edits on Device A propagate to Device B through the remote relay.
 * The remote server itself still holds no durable state; it is a pure relay.
 *
 * @example
 * ```typescript
 * import { Database } from 'bun:sqlite';
 *
 * // No auth (development)
 * createRemoteServer({}).start();
 *
 * // Shared token (enterprise self-hosted — no database needed)
 * createRemoteServer({
 *   auth: { mode: 'token', token: process.env.EPICENTER_TOKEN! },
 * }).start();
 *
 * // Full user accounts (cloud deployment)
 * createRemoteServer({
 *   auth: {
 *     mode: 'betterAuth',
 *     database: new Database('auth.db'),
 *     secret: 'my-secret',
 *     trustedOrigins: ['tauri://localhost'],
 *     socialProviders: { github: { clientId: '...', clientSecret: '...' } },
 *   },
 * }).start();
 * ```
 */
export function createRemoteServer({
	sync,
	auth: authMode,
	port,
}: RemoteServerConfig) {
	const authConfig = authMode ?? { mode: 'none' as const };

	// Create Better Auth instance early so it can be shared between
	// the auth plugin and the auto-wired sync verify function.
	const auth =
		authConfig.mode === 'betterAuth' ? createBetterAuth(authConfig) : undefined;

	// Auto-wire sync auth from the top-level auth config when
	// sync.verifyToken is not explicitly provided:
	// - none     → no sync auth
	// - token    → direct token comparison
	// - betterAuth → session validation via auth.api.getSession()
	const syncVerifyToken:
		| ((token: string) => boolean | Promise<boolean>)
		| undefined =
		sync?.verifyToken ??
		(authConfig.mode === 'token'
			? (token: string) => token === authConfig.token
			: auth
				? async (token: string) => {
						const session = await auth.api.getSession({
							headers: new Headers({ authorization: `Bearer ${token}` }),
						});
						return session !== null;
					}
				: undefined);

	/** Ephemeral Y.Docs for rooms (remote server is a pure relay, no pre-registered workspaces). */
	const dynamicDocs = new Map<string, Y.Doc>();

	const app = new Elysia()
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter Remote API',
						version: '1.0.0',
						description:
							'Remote server — sync relay, AI streaming, and coordination.',
					},
				},
			}),
		)
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createWsSyncPlugin({
					getDoc: (room) => {
						if (!dynamicDocs.has(room)) {
							dynamicDocs.set(room, new Y.Doc());
						}
						return dynamicDocs.get(room);
					},
					verifyToken: syncVerifyToken,
					onRoomCreated: sync?.onRoomCreated,
					onRoomEvicted: sync?.onRoomEvicted,
				}),
			),
		)
		.use(new Elysia({ prefix: '/ai' }).use(createAIPlugin()))
		.get('/', () => ({
			name: 'Epicenter Remote',
			version: '1.0.0',
			mode: 'remote' as const,
		}));

	// Mount auth middleware based on mode.
	if (authConfig.mode === 'token') {
		app.use(createTokenGuardPlugin(authConfig.token));
	} else if (auth) {
		// Better Auth mode: mount session-based auth at /auth/*.
		app.use(createAuthPlugin(auth));
	}

	// Mount AI proxy unconditionally — reads API keys from env vars
	app.use(createProxyPlugin());

	const preferredPort = port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	return {
		app,

		/**
		 * Start listening on the preferred port, falling back to an OS-assigned
		 * port if it's already taken.
		 *
		 * Does not log or install signal handlers — the caller owns those concerns.
		 */
		start() {
			const actualPort = listenWithFallback(app, preferredPort);
			return { ...app.server!, port: actualPort };
		},

		/**
		 * Stop the HTTP server and clean up resources.
		 */
		async stop() {
			app.stop();
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}
