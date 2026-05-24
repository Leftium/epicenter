/**
 * @epicenter/server
 *
 * Shared Hono server for Epicenter cloud and self-hosted team
 * deployments. Personal mode partitions data by user; team mode does
 * not partition. The full design lives in
 * `specs/20260522T230000-server-package-split.md`.
 *
 * Deployments import the parent base app and the sub-apps they need,
 * then compose auth and (where applicable) billing middleware around
 * each sub-app at mount time. Sub-apps declare full URLs (including the
 * `/api` prefix where applicable); deployments mount them at `/`.
 * See `apps/api/src/index.ts` for the cloud composition.
 */

// Parent app. Wires per-request lifecycle (pg, after-response queue,
// auth context, CORS, single-credential normalization, CSRF, rooms
// registry). Mount every sub-app on this one.
export { createBaseApp } from './base-app.js';
// Middleware deployments compose around sub-apps.
export { createAttachOwner } from './middleware/attach-owner.js';
export {
	requireBearerUser,
	requireCookieOrBearerUser,
} from './middleware/require-auth.js';
export { requireUrlOwnerIdMatchesAuth } from './middleware/require-url-owner-id-matches-auth.js';
// Re-export the Cloudflare Durable Object class so each deployment's
// wrangler.jsonc can resolve `class_name: "Room"` against this entrypoint.
export { Room } from './room/backends/cloudflare/durable-object.js';
// Sub-apps. Each declares its full URL pattern internally; the
// deployment composes auth and billing middleware around them.
export { aiApp } from './routes/ai.js';
export { createAssetsApp } from './routes/assets.js';
export { authApp } from './routes/auth.js';
export { roomsApp } from './routes/rooms.js';
export { sessionApp } from './routes/session.js';

// Public Hono context type the deployment composes around library
// middleware. `OwnershipMode` and `SignUpPolicy` stay internal: factories
// accept the literal values directly.
export type { Env } from './types.js';
