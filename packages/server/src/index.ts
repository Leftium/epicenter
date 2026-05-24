/**
 * @epicenter/server
 *
 * Shared Hono server for Epicenter cloud and self-hosted team
 * deployments. Personal mode partitions data by user; team mode does
 * not partition. The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 */

// Top-level factory.
export { createServer } from './create-server.js';
// Middleware deployments compose around library sub-apps. Auth is mounted by
// the deployment (not the library) so cloud can interleave Autumn gates
// between the auth check and the handler.
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { requireUrlOwnerIdMatchesAuth } from './middleware/require-url-owner-id-matches-auth.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// Public configuration surface. `Env` is the Hono context type the
// deployment composes around library middleware; `ServerOptions` is the
// `createServer` config. Other types (`Connection`, `AfterResponseQueue`,
// `SignUpPolicy`, `OwnerPath`, `RoomDoName`, `AssetR2Key`) and helpers
// (`assetKey`, `doName`) are intentionally not re-exported: they are
// internal to the library and have no current external consumers.
export type { Env, ServerOptions } from './types.js';
