import { type AppId, PORTS } from '#ports';

type AppConfig = {
	URL: string;
};

/**
 * Produces a map of all Epicenter applications with their metadata. Currently only includes the URL,
 * which varies depending on the environment (development or production).
 *
 * Dev ports are derived from {@link PORTS} so there is a single source of truth—changing a port in
 * `ports.ts` updates every URL and vite config automatically.
 *
 * These URLs are reused in Vite, Node, and Cloudflare to properly access specific app URLs.
 */
export const createApps = (env: 'development' | 'production') => {
	const isDev = env === 'development';
	return {
		/**
		 * Main API service for the application ecosystem (includes auth)
		 */
		API: {
			URL: isDev ? `http://localhost:${PORTS.API}` : 'https://api.epicenter.so',
		},
		/**
		 * Main epicenter.sh web application
		 */
		SH: {
			URL: isDev ? `http://localhost:${PORTS.SH}` : 'https://epicenter.sh',
		},
		/**
		 * Whispering audio transcription application
		 */
		AUDIO: {
			URL: isDev
				? `http://localhost:${PORTS.AUDIO}`
				: 'https://whispering.epicenter.so',
		},
	} as const satisfies Record<AppId, AppConfig>;
};
