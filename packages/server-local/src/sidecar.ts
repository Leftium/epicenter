import type { AnyWorkspaceClient } from '@epicenter/workspace';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { openAPIRouteHandler } from 'hono-openapi';
import * as Y from 'yjs';
import { createAuthMiddleware } from './middleware/auth';
import { serve } from './server';
import { createWsSyncPlugin } from './sync/ws-plugin';
import { createWorkspacePlugin } from './workspace';
import { collectActionPaths } from './workspace/actions';

/**
 * Auth configuration for the sidecar.
 *
 * The sidecar is always a **consumer** of authentication — it never
 * issues sessions or manages user accounts.
 *
 * Three mutually exclusive modes:
 *
 * - **`none`** — No authentication. Relies on CORS origin restrictions
 *   (default: `tauri://localhost`) as the security boundary.
 *
 * - **`token`** — A single pre-shared secret. Everyone who knows the
 *   token can access the sidecar.
 *
 * - **`remote`** — Delegates authentication to the hub by calling
 *   its `GET /auth/get-session` endpoint with the Bearer token.
 */
export type SidecarAuthConfig =
	| {
			mode: 'none';
	  }
	| {
			mode: 'token';
			token: string;
	  }
	| {
			mode: 'remote';
			hubUrl: string;
			cacheTtlMs?: number;
	  };

export type SidecarConfig = {
	/** Workspace clients to expose via REST CRUD and action endpoints. */
	clients: AnyWorkspaceClient[];

	/**
	 * Preferred port to listen on.
	 * Falls back to `PORT` env var, then 3913.
	 * If the port is taken, the OS assigns an available one.
	 */
	port?: number;

	/** Authentication mode. Defaults to `{ mode: 'none' }`. */
	auth?: SidecarAuthConfig;

	/**
	 * CORS allowed origins.
	 * Default: `['tauri://localhost']`.
	 */
	allowedOrigins?: string[];

	/** Sync plugin options (WebSocket rooms, auth, lifecycle hooks). */
	sync?: {
		verifyToken?: (token: string) => boolean | Promise<boolean>;
		onRoomCreated?: (roomId: string, doc: Y.Doc) => void;
		onRoomEvicted?: (roomId: string, doc: Y.Doc) => void;
	};
};

/**
 * Create an Epicenter sidecar — the per-device data and execution plane.
 *
 * Provides workspace CRUD, action endpoints, and local Yjs sync relay.
 */
export function createSidecar({
	clients,
	sync,
	auth,
	allowedOrigins,
	port,
}: SidecarConfig) {
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

	// Build sync routes + websocket handler
	const { syncApp, websocket } = createWsSyncPlugin({
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
		verifyToken: sync?.verifyToken,
		onRoomCreated: sync?.onRoomCreated,
		onRoomEvicted: sync?.onRoomEvicted,
	});

	const app = new Hono();

	// CORS
	app.use(
		'*',
		cors({
			origin: allowedOrigins ?? ['tauri://localhost'],
			credentials: true,
			allowHeaders: ['Content-Type', 'Authorization'],
		}),
	);

	// Auth
	app.use('*', createAuthMiddleware(auth ?? { mode: 'none' }));

	// Discovery endpoint
	app.get('/', (c) =>
		c.json({
			name: 'Epicenter Sidecar',
			version: '1.0.0',
			mode: 'sidecar' as const,
			workspaces: Object.keys(workspaces),
			actions: allActionPaths,
		}),
	);

	// Mount sync and workspace routes
	app.route('/rooms', syncApp);
	app.route('/workspaces', createWorkspacePlugin(clients));

	// OpenAPI spec endpoint
	app.get(
		'/openapi',
		openAPIRouteHandler(app, {
			documentation: {
				info: { title: 'Epicenter Sidecar API', version: '1.0.0' },
			},
		}),
	);

	const preferredPort = port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	let bunServer: ReturnType<typeof Bun.serve> | null = null;

	return {
		app,

		/** Start listening, falling back to an OS-assigned port if needed. */
		start() {
			const { server, port: actualPort } = serve(app, preferredPort, websocket);
			bunServer = server;
			return { server, port: actualPort };
		},

		/** Stop the HTTP server and destroy all workspace clients. */
		async stop() {
			bunServer?.stop();
			bunServer = null;
			await Promise.all(clients.map((c) => c.destroy()));
			for (const doc of dynamicDocs.values()) doc.destroy();
			dynamicDocs.clear();
		},
	};
}

export type SidecarApp = ReturnType<typeof createSidecar>['app'];
