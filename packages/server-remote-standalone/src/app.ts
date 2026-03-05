import { createSharedApp } from '@epicenter/server-remote';
import {
	createStandaloneAuth,
	type StandaloneAuthConfig,
} from './auth';
import { mountSyncRoutes } from './sync-adapter';

type StandaloneAppConfig = {
	auth: StandaloneAuthConfig;
	sync?: {
		onRoomCreated?: (roomId: string) => void;
		onRoomEvicted?: (roomId: string) => void;
		evictionTimeout?: number;
	};
};

/**
 * Assemble the standalone Hono app.
 *
 * 1. Creates auth instance from config
 * 2. Builds shared app (health, auth routes, AI/proxy, auth middleware)
 * 3. Mounts sync WebSocket + HTTP routes
 */
export function createStandaloneApp(config: StandaloneAppConfig) {
	const { auth, betterAuth } = createStandaloneAuth(config.auth);

	const app = createSharedApp({
		auth,
		healthMeta: { runtime: 'standalone' },
	});

	const { roomManager } = mountSyncRoutes(app, config.sync);

	return { app, roomManager, betterAuth };
}
