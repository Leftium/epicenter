import {
	createServerFactory,
	createSharedApp,
} from '@epicenter/server-remote';
import type { UpdateLog } from '@epicenter/sync-core';
import { createStandaloneAuth, type StandaloneAuthConfig } from './auth';
import { mountSyncRoutes } from './sync-adapter';

type StandaloneAppConfig = {
	auth: StandaloneAuthConfig;
	sync: {
		storage: UpdateLog;
		onRoomCreated?: (roomId: string) => void;
		onRoomEvicted?: (roomId: string) => void;
		evictionTimeout?: number;
	};
};

const factory = createServerFactory();

/**
 * Assemble the standalone Hono app.
 *
 * 1. Creates auth instance from config
 * 2. Creates own Hono app and mounts shared routes (health, auth, AI/proxy)
 * 3. Applies auth middleware for rooms
 * 4. Mounts sync WebSocket + HTTP routes with persistent storage
 */
export function createStandaloneApp(config: StandaloneAppConfig) {
	const { auth, betterAuth } = createStandaloneAuth(config.auth);

	const { app: sharedApp, createAuthGuard } = createSharedApp({
		factory,
		auth,
		healthMeta: { runtime: 'standalone' },
	});

	const app = factory.createApp();

	// Mount shared routes (health, auth, OAuth discovery, AI chat, proxy)
	app.route('/', sharedApp);

	// Auth middleware for rooms — must be on the parent app since /rooms/:room
	// is defined here via mountSyncRoutes, not in the shared sub-app.
	app.use('/rooms/*', createAuthGuard());

	const { roomManager } = mountSyncRoutes(app, config.sync);

	return { app, roomManager, betterAuth };
}
