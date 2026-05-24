/**
 * Top-level factory for `@epicenter/server`.
 *
 * Returns named sub-apps the deployment composes onto a single `Hono`
 * instance. Each sub-app reads `opts.mode` once, at construction; downstream
 * handlers operate on a resolved `OwnerId` value uniformly. URL patterns are
 * uniform across modes (`/owners/:ownerId/...`); the only mode-specific
 * behavior is which middleware the deployment layers on (personal mode adds
 * the URL-vs-auth safety gate).
 *
 * Cloud and team deployments call `createServer` with one of:
 *
 *   { mode: 'personal', signUpPolicy: 'open' }       Epicenter Cloud
 *   { mode: 'team',     signUpPolicy: 'disabled' }   self-hosted team
 *
 * The deployment composition mounts the returned sub-apps. See
 * `specs/20260522T230000-server-package-split.md` for the full design.
 */

import { createAttachOwner } from './middleware/attach-owner.js';
import { createBaseApp } from './base-app.js';
import { createAiApp } from './routes/ai.js';
import { createAssetsApp } from './routes/assets.js';
import { createAuthApp } from './routes/auth.js';
import { createRoomsApp } from './routes/rooms.js';
import { createSessionApp } from './routes/session.js';
import type { ServerOptions } from './types.js';

export function createServer(opts: ServerOptions) {
	return {
		/**
		 * Parent Hono app. Carries CORS, per-request pg lifecycle, auth
		 * context, single-credential normalization, CSRF, and the rooms
		 * registry. Mount every other sub-app on this one.
		 */
		base: createBaseApp(opts),

		/** /sign-in, /consent, /auth/cli-callback, OAuth discovery, /auth/*. */
		auth: createAuthApp(opts),

		/** /api/session: authenticated session projection plus keyring. */
		session: createSessionApp(opts),

		/** /api/.../rooms/:roomId: GET, POST, WS upgrade. */
		rooms: createRoomsApp(),

		/** /api/.../assets: public read + authed CRUD. */
		assets: createAssetsApp(opts),

		/** /api/ai/chat: SSE streaming chat (no billing; wrap externally). */
		ai: createAiApp(),

		/**
		 * Middleware that populates `c.var.ownerId` from
		 * `(opts.mode, c.var.user.id)`. The deployment mounts this alongside
		 * the auth middleware on every authed sub-app that reads
		 * `c.var.ownerId` (rooms, assets). The session sub-app builds its
		 * own internally because it carries its own auth.
		 */
		attachOwner: createAttachOwner(opts.mode),
	};
}
