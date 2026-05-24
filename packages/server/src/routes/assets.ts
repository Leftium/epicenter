/**
 * Assets sub-app: owner-partitioned URL shapes for the asset CRUD surface.
 *
 * Uniform URL shape across modes:
 *   POST /owners/:ownerId/assets              authed upload
 *   GET  /owners/:ownerId/assets              authed list
 *   GET  /owners/:ownerId/assets/usage        authed usage
 *   DEL  /owners/:ownerId/assets/:assetId     authed delete
 *   GET  /owners/:ownerId/assets/:assetId     public read (capability URL)
 *
 * The resolved owner partition arrives on `c.var.ownerId` via the
 * deployment-mounted `attachOwner` middleware. In personal mode the
 * deployment also layers `requireUrlOwnerIdMatchesAuth` to gate
 * `:ownerId === c.var.user.id`; in team mode `:ownerId` is pinned to
 * `TEAM_OWNER_ID` by the route pattern and no gate is needed.
 *
 * Authentication and any billing gating are layered on by the deployment,
 * not by this factory. The library returns bare CRUD; cloud wraps the
 * authed paths with `requireCookieOrBearerUser`, `requireUrlOwnerIdMatchesAuth`,
 * `attachOwner`, and `autumnStorageGate`; team wraps with
 * `requireCookieOrBearerUser` and `attachOwner` alone.
 */

import { Hono } from 'hono';
import {
	createAssetAuthedRoutes,
	createAssetPublicRoutes,
} from '../asset-routes.js';
import type { Env, ServerOptions } from '../types.js';

export function createAssetsApp(opts: ServerOptions): Hono<Env> {
	const app = new Hono<Env>();

	// Public read mounts first so the deployment's auth middleware (applied
	// at the same prefix) does not intercept GETs for the capability URL.
	app.route('/owners/:ownerId/assets', createAssetPublicRoutes());
	app.route('/owners/:ownerId/assets', createAssetAuthedRoutes(opts.mode));

	return app;
}
