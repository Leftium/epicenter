/// <reference types="vite/client" />

import { createApps } from '#apps';

/**
 * Vite build-time URLs.
 *
 * Uses `import.meta.env.MODE` for environment detection. Any mode other than
 * `'production'` resolves to development URLs—safe default for local dev,
 * preview, and test builds.
 */
const mode =
	import.meta.env.MODE === 'production' ? 'production' : 'development';

export const APPS = createApps(mode);
