/**
 * Fuji project mount entry point.
 *
 * Keep this file at the app root so local project configs can import
 * `../epicenter/apps/fuji/project.ts`, matching the other app packages.
 */

export {
	type FujiMount,
	type FujiMountOptions,
	fuji,
} from './src/lib/workspace/project.js';
