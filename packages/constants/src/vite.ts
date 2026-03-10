/// <reference types="vite/client" />

import { createApps } from '#apps';

/**
 * Vite build-time URLs.
 * Uses import.meta.env.MODE for environment detection.
 *
 * For use in Vite contexts (client-side applications).
 */
// @ts-expect-error TODO properly assert this
export const APPS = createApps(import.meta.env.MODE);
