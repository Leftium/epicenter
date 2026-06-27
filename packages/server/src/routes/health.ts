import { Hono } from 'hono';
import packageJson from '../../package.json' with { type: 'json' };
import type { Env } from '../types.js';

/**
 * The version every deployable's health probe reports: the `@epicenter/server`
 * runtime version they all embed, read from this package's own `package.json`
 * so the three entries cannot drift from it or from the real published version.
 * Hardcoding it in each entry let it rot (every copy read `0.1.0` while no
 * package was at `0.1.0`); deriving it keeps the probe honest for free.
 */
const SERVER_VERSION = packageJson.version;

/**
 * Mount the public health probe at `GET /`, returning the deployable's identity:
 * its ownership `mode` (`hub` | `shared`), the shared runtime `version`, and the
 * `runtime` that serves it. One home for the probe's shape, shared by the Bun
 * and Cloudflare entries so they cannot disagree.
 */
export function mountHealth(
	app: Hono<Env>,
	{ mode, runtime }: { mode: string; runtime: 'bun' | 'cloudflare' },
): void {
	app.get('/', (c) => c.json({ mode, version: SERVER_VERSION, runtime }));
}
