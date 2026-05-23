/**
 * Node-only runtime configuration: every Epicenter env var and platform
 * path, resolved through one named singleton.
 *
 * Read `epicenterEnv.dataDir` (or `.logDir`, `.runtimeDir`, ...) wherever
 * you would have reached for `process.env.X` or hand-rolled an XDG
 * fallback. Each property is a lazy getter: env vars are re-read on
 * every access so tests that mutate `process.env` between setup and
 * exercise continue to work without ceremony.
 *
 * env-paths captures `os.homedir()` at module load and cannot be
 * re-pointed at runtime, so the platform fallbacks (`paths.data`,
 * `paths.log`, etc.) are computed once on import. Tests that need to
 * redirect a directory must do so via the `EPICENTER_*_DIR` overrides
 * this module consumes.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import envPaths from 'env-paths';
import { EPICENTER_API_URL as DEFAULT_API_URL } from './apps.js';

const paths = envPaths('epicenter', { suffix: '' });

export const epicenterEnv = {
	get apiUrl(): string {
		return process.env.EPICENTER_API_URL ?? DEFAULT_API_URL;
	},
	get dataDir(): string {
		return process.env.EPICENTER_DATA_DIR ?? paths.data;
	},
	get logDir(): string {
		return process.env.EPICENTER_LOG_DIR ?? paths.log;
	},
	get cacheDir(): string {
		return process.env.EPICENTER_CACHE_DIR ?? paths.cache;
	},
	get configDir(): string {
		return process.env.EPICENTER_CONFIG_DIR ?? paths.config;
	},
	get runtimeDir(): string {
		return join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), 'epicenter');
	},
} as const;
