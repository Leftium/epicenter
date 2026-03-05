import type { StandaloneAuthConfig } from './auth';
import { seedAdminIfNeeded } from './auth';
import { createStandaloneApp } from './app';
import { websocket } from './sync-adapter';

declare const Bun: {
	serve(options: {
		port: number;
		fetch: (req: Request) => Response | Promise<Response>;
		websocket: unknown;
	}): { port: number; stop(): void };
};

export type StandaloneHubConfig = {
	/** Authentication mode. Defaults to `{ mode: 'none' }`. */
	auth?: StandaloneAuthConfig;

	/**
	 * Preferred port. Falls back to `PORT` env, then 3913.
	 * If the port is taken, Bun.serve will throw — the caller should handle this.
	 */
	port?: number;

	/** Sync lifecycle hooks. */
	sync?: {
		onRoomCreated?: (roomId: string) => void;
		onRoomEvicted?: (roomId: string) => void;
		evictionTimeout?: number;
	};
};

/**
 * Create a standalone remote hub server.
 *
 * Returns a Hono app and lifecycle methods (`start`, `stop`).
 * The `stop()` method calls `roomManager.destroy()` to clear all rooms,
 * timers, and Y.Docs.
 *
 * @example
 * ```typescript
 * const hub = createRemoteHub({ auth: { mode: 'token', token: 'secret' } });
 * const { port } = await hub.start();
 * console.log(`Hub listening on port ${port}`);
 * ```
 */
export function createRemoteHub(config: StandaloneHubConfig = {}) {
	const authConfig = config.auth ?? { mode: 'none' as const };
	const preferredPort =
		config.port ?? Number.parseInt(process.env.PORT ?? '3913', 10);

	const { app, roomManager, betterAuth } = createStandaloneApp({
		auth: authConfig,
		sync: config.sync,
	});

	let server: { port: number; stop(): void } | undefined;

	return {
		app,

		async start(): Promise<{ port: number }> {
			// Seed admin user in betterAuth mode
			if (betterAuth) {
				await seedAdminIfNeeded(betterAuth);
			}

			server = Bun.serve({
				port: preferredPort,
				fetch: app.fetch,
				websocket,
			});

			return { port: server.port };
		},

		async stop(): Promise<void> {
			roomManager.destroy();
			server?.stop();
		},
	};
}

/** Bun entry point shape for direct `bun run` usage. */
export { websocket };
