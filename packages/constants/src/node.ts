/**
 * Node-only runtime configuration: every Epicenter env var and platform
 * path, resolved in one call.
 *
 * Call `createEpicenterEnv()` wherever you would have reached for
 * `process.env.SOMETHING` or hand-rolled an XDG fallback. The return value
 * is frozen and self-contained; pass it down or call the factory again,
 * either is cheap. The `env` argument exists so tests can inject a
 * different mapping without mutating the real `process.env`.
 *
 * env-paths captures `os.homedir()` at module load and cannot be
 * re-pointed at runtime. Tests that need to redirect the data, log,
 * cache, or config directories must do so via the `EPICENTER_*_DIR`
 * overrides this factory consumes.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { EPICENTER_API_URL as DEFAULT_API_URL } from './apps.js';

export function createEpicenterEnv(env: NodeJS.ProcessEnv = process.env) {
	const paths = envPaths('epicenter', { suffix: '' });
	return Object.freeze({
		apiUrl: env.EPICENTER_API_URL ?? DEFAULT_API_URL,
		dataDir: env.EPICENTER_DATA_DIR ?? paths.data,
		logDir: env.EPICENTER_LOG_DIR ?? paths.log,
		cacheDir: env.EPICENTER_CACHE_DIR ?? paths.cache,
		configDir: env.EPICENTER_CONFIG_DIR ?? paths.config,
		runtimeDir: join(env.XDG_RUNTIME_DIR ?? tmpdir(), 'epicenter'),
	});
}

export type EpicenterEnv = ReturnType<typeof createEpicenterEnv>;
