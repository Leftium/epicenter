/**
 * Single source of truth for all Epicenter app URLs and ports.
 *
 * Each app declares its dev `port` and canonical production `url`. Apps
 * reachable at more than one domain add `aliases`. The canonical `url` is
 * used by Vite prod builds; `url` plus `aliases` together are included in
 * CORS and trusted origins (see {@link prodOrigins}).
 *
 * To add an app: add an entry here. TypeScript enforces that every
 * consumer picks it up automatically.
 */

/**
 * Canonical production origin for the Epicenter API. Single source of truth
 * for the hosted cloud's public origin: the `API` entry below, the fallback
 * for {@link EPICENTER_API_URL}, and the baked default the hosted worker uses
 * when no `API_PUBLIC_ORIGIN` override is present (apps/api/worker/index.ts).
 * The hosted origin never changes per deploy, so it lives here in TypeScript
 * rather than being duplicated into apps/api's wrangler.jsonc vars.
 *
 * The dashboard SPA is served at `api.epicenter.so/dashboard` (same origin as
 * the API) so it does not get its own APPS entry; its dev port lives inline in
 * `apps/api/ui/vite.config.ts`.
 */
export const PRODUCTION_API_URL = 'https://api.epicenter.so';

export const APPS = {
	API: { port: 8787, url: PRODUCTION_API_URL },
	SH: { port: 5173, url: 'https://epicenter.sh' },
	AUDIO: { port: 1420, url: 'https://whispering.epicenter.so' },
	FUJI: { port: 5174, url: 'https://fuji.epicenter.so' },
	HONEYCRISP: { port: 5175, url: 'https://honeycrisp.epicenter.so' },
	OPENSIDIAN: {
		port: 5176,
		url: 'https://opensidian.com',
		aliases: ['https://opensidian.epicenter.so'],
	},
	ZHONGWEN: { port: 8888, url: 'https://zhongwen.epicenter.so' },
} as const;

export type AppId = keyof typeof APPS;

/**
 * Local dev URL for an app, derived from its `port`. Single owner for the
 * `http://localhost:<port>` shape: CORS trusted origins, the API runtime's
 * dev classifier, the dev-server origin override, and the OAuth seed all read
 * this.
 *
 * The `Port` generic preserves the literal port through the template so
 * `localUrl(APPS.API)` infers `"http://localhost:8787"`, not `string`.
 * Consumers that hand the result to Better Auth (e.g. `trustedOrigins`)
 * widen to `string` at that boundary on purpose; see
 * `packages/server/src/trusted-origins.ts`.
 */
export function localUrl<Port extends number>(app: {
	port: Port;
}) {
	return `http://localhost:${app.port}` as const;
}

/**
 * Every production origin an app answers on: its canonical `url` plus any
 * `aliases`. Single owner for expanding the canonical-plus-alias pair into a
 * flat list, read by CORS trusted origins and OAuth redirect URIs. Only apps
 * reachable at more than one domain (e.g. Opensidian) declare `aliases`; for
 * everyone else this is a one-element list.
 */
export function prodOrigins(app: {
	url: string;
	aliases?: readonly string[];
}): readonly string[] {
	return [app.url, ...(app.aliases ?? [])];
}

/**
 * Default API base URL for Node consumers (CLI, daemon, tests). The constant
 * resolves to `process.env.EPICENTER_API_URL` when set, else
 * {@link PRODUCTION_API_URL}. Browsers and Workers lack `process.env`, so
 * they fall through to the production default automatically.
 */
export const EPICENTER_API_URL =
	(typeof process !== 'undefined' && process.env?.EPICENTER_API_URL) ||
	PRODUCTION_API_URL;
