/**
 * Fuji mount entry point.
 *
 * Keep this file at the app root so an `epicenter.config.ts` can import
 * `@epicenter/fuji/mount`, matching the other app packages.
 */

export { fuji } from './src/lib/workspace/mount.js';
