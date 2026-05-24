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

import type { Hono } from 'hono';
import { createBaseApp } from './base-app.js';
import { createAttachOwner } from './middleware/attach-owner.js';
import { createAiApp } from './routes/ai.js';
import { createAssetsApp } from './routes/assets.js';
import { createAuthApp } from './routes/auth.js';
import { createRoomsApp } from './routes/rooms.js';
import { createSessionApp } from './routes/session.js';
import type { Env, ServerOptions } from './types.js';

/**
 * Sub-app bundle returned by {@link createServer}.
 *
 * Generic over `E` so deployments that extend the library `Env` (e.g.
 * Epicenter Cloud adds `planId` to `Variables`) get sub-apps typed against
 * the deployment's full env, and `.use(deploymentMiddleware)` chains
 * typecheck without casting at every mount site. Internally each sub-app
 * is constructed against the library `Env`; the widening is correct
 * because the deployment env always includes every library variable, and
 * the library never reads the deployment's extra variables.
 */
export type Server<E extends Env = Env> = {
	base: Hono<E>;
	auth: Hono<E>;
	session: Hono<E>;
	rooms: Hono<E>;
	assets: Hono<E>;
	ai: Hono<E>;
	attachOwner: ReturnType<typeof createAttachOwner>;
};

export function createServer<E extends Env = Env>(
	opts: ServerOptions,
): Server<E> {
	// Each sub-app is a `Hono<Env>` at construction. The single widening cast
	// to `Hono<E>` lives here so deployments do not repeat it at every mount.
	const widen = <T>(app: T) => app as unknown as Hono<E>;
	return {
		/**
		 * Parent Hono app. Carries CORS, per-request pg lifecycle, auth
		 * context, single-credential normalization, CSRF, and the rooms
		 * registry. Mount every other sub-app on this one.
		 */
		base: widen(createBaseApp(opts)),

		/** /sign-in, /consent, /auth/cli-callback, OAuth discovery, /auth/*. */
		auth: widen(createAuthApp()),

		/** /api/session: authenticated session projection plus keyring. */
		session: widen(createSessionApp(opts)),

		/** /api/.../rooms/:roomId: GET, POST, WS upgrade. */
		rooms: widen(createRoomsApp()),

		/** /api/.../assets: public read + authed CRUD. */
		assets: widen(createAssetsApp(opts)),

		/** /api/ai/chat: SSE streaming chat (no billing; wrap externally). */
		ai: widen(createAiApp()),

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
