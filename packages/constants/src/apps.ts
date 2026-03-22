/**
 * Single source of truth for all Epicenter app URLs and ports.
 *
 * Each app declares its dev port and production URL. Everything else
 * is derived from this map.
 *
 * To add an app: add an entry here. TypeScript enforces that every
 * consumer picks it up automatically.
 */

export const APPS = {
	API: { port: 8787, url: 'https://api.epicenter.so' },
	SH: { port: 5173, url: 'https://epicenter.sh' },
	AUDIO: { port: 1420, url: 'https://whispering.epicenter.so' },
} as const;

export type AppId = keyof typeof APPS;
