import { cors } from '@elysiajs/cors';
import { openapi } from '@elysiajs/openapi';
import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Elysia } from 'elysia';
import * as Y from 'yjs';
import { createHubSessionValidator } from './auth/local-auth';
import type { AuthConfig } from './sync/auth';
import { createSyncPlugin } from './sync/plugin';
import { createWorkspacePlugin } from './workspace';
import { collectActionPaths } from './workspace/actions';

export { DEFAULT_PORT } from './server';

export type LocalServerConfig = {
	/**
	 * Workspace clients to expose via REST CRUD and action endpoints.
	 *
	 * Pass an empty array for a sync-only relay (no workspace routes).
	 * Non-empty arrays mount table and action endpoints under `/workspaces/{id}`.
	 */
	clients: AnyWorkspaceClient[];

	/**
	 * Port to listen on.
	 *
	 * Falls back to the `PORT` environment variable, then 3913.
	 */
	port?: number;

	/**
	 * Hub URL for session token validation.
	 *
	 * When provided, the local server validates all requests by checking
	 * the Bearer token against the hub's `/auth/get-session` endpoint.
	 * Results are cached with a 5-minute TTL.
	 *
	 * Omit for open mode (no auth, development only).
	 */
	hubUrl?: string;

	/**
	 * CORS allowed origins.
	 *
	 * Default: `['tauri://localhost']` — only the Tauri webview can call the local server.
	 * Add the hub origin if the hub needs to reach it directly.
	 */
	allowedOrigins?: string[];

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		/** Auth for sync endpoints. Omit for open mode (no auth). */
		auth?: AuthConfig;

		/** Called when a new sync room is created on demand. */
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;

		/** Called when an idle sync room is evicted after all clients disconnect. */
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};

/**
 * Create an Elysia plugin for auth guard (if hubUrl configured).
 *
 * Separated into its own plugin so the type chain is not broken by conditionals.
 */
function createAuthGuardPlugin(hubUrl?: string) {
	const plugin = new Elysia();
	if (!hubUrl) return plugin;

	const validateSession = createHubSessionValidator({ hubUrl });
	plugin.onBeforeHandle(
		{ as: 'global' },
		async ({ request, status, path }) => {
			if (path === '/') return;

			const authHeader = request.headers.get('authorization');
			if (!authHeader?.startsWith('Bearer ')) {
				return status(401, 'Unauthorized: Bearer token required');
			}

			const token = authHeader.slice(7);
			const result = await validateSession(token);

			if (!result.valid) {
				return status(401, 'Unauthorized: Invalid session token');
			}
		},
	);
	return plugin;
}

/**
 * Create an Epicenter local server.
 *
 * The local server runs on each desktop (as a Tauri sidecar process). It provides:
 * - Sync relay (local) — fast sub-ms WebSocket sync between webview and Y.Doc
 * - Workspace API — RESTful CRUD for workspace tables and actions
 * - CORS protection — only Tauri webview origin allowed by default
 * - Session token auth — validates against hub when hubUrl is configured
 * - OpenAPI docs
 * - Discovery root
 *
 * The local server does NOT handle AI streaming — all AI goes through the hub.
 *
 * @example
 * ```typescript
 * // Local server with auth (production)
 * createLocalServer({
 *   clients: [blogClient],
 *   hubUrl: 'https://hub.example.com',
 *   allowedOrigins: ['tauri://localhost'],
 * }).start();
 *
 * // Minimal local server (development, no auth)
 * createLocalServer({ clients: [] }).start();
 * ```
 */
export function createLocalServer(config: LocalServerConfig) {
	const { clients, sync } = config;

	const workspaces: Record<string, AnyWorkspaceClient> = {};
	for (const client of clients) {
		workspaces[client.id] = client;
	}

	/** Ephemeral Y.Docs for rooms with no pre-registered workspace client. */
	const dynamicDocs = new Map<string, Y.Doc>();

	const allActionPaths = clients.flatMap((client) => {
		if (!client.actions) return [];
		return collectActionPaths(client.actions).map((p) => `${client.id}/${p}`);
	});

	const app = new Elysia()
		.use(
			cors({
				origin: config.allowedOrigins ?? ['tauri://localhost'],
				credentials: true,
				allowedHeaders: ['Content-Type', 'Authorization'],
			}),
		)
		.use(
			openapi({
				embedSpec: true,
				documentation: {
					info: {
						title: 'Epicenter Sidecar API',
						version: '1.0.0',
						description:
							'Sidecar server — local sync relay and workspace API.',
					},
				},
			}),
		)
		.use(createAuthGuardPlugin(config.hubUrl))
		.use(
			new Elysia({ prefix: '/rooms' }).use(
				createSyncPlugin({
					getDoc:
						clients.length > 0
							? (room) => {
									if (workspaces[room]) return workspaces[room].ydoc;

									if (!dynamicDocs.has(room)) {
										dynamicDocs.set(room, new Y.Doc());
									}
									return dynamicDocs.get(room);
								}
							: undefined,
					auth: sync?.auth,
					onRoomCreated: sync?.onRoomCreated,
					onRoomEvicted: sync?.onRoomEvicted,
				}),
			),
		)
		.get('/', () => ({
			name: 'Epicenter Local',
			version: '1.0.0',
			mode: 'local' as const,
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}))
		.use(
			new Elysia({ prefix: '/workspaces' }).use(
				createWorkspacePlugin(clients),
			),
		);

	const port = config.port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	return {
		app,

		/**
		 * Start listening on the configured port.
		 *
		 * Does not log or install signal handlers — the caller owns those concerns.
		 */
		start() {
			app.listen(port);
			return app.server;
		},

		/**
		 * Stop the HTTP server and destroy all workspace clients.
		 *
		 * Cleans up workspace clients, ephemeral sync documents, and the HTTP listener.
		 */
		async stop() {
			app.stop();
			await Promise.all(clients.map((c) => c.destroy()));
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}

export type LocalApp = ReturnType<typeof createLocalServer>['app'];
