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
 * In personal mode `:ownerId` is the signed-in user's id and the deployment
 * layers `requireUrlOwnerIdMatchesAuth` to gate `:ownerId === c.var.user.id`.
 * In team mode `:ownerId` carries the literal string `'team'` and no gate is
 * needed.
 *
 * Authentication and any billing gating are layered on by the deployment,
 * not by this factory. The library returns bare CRUD; cloud wraps the
 * authed paths with `requireCookieOrBearerUser`, `requireUrlOwnerIdMatchesAuth`,
 * and `autumnStorageGate`; team wraps with `requireCookieOrBearerUser` alone.
 */

import { asOwnerId } from '@epicenter/auth';
import type { Context } from 'hono';
import { Hono } from 'hono';
import {
	createAssetAuthedRoutes,
	createAssetPublicRoutes,
} from '../asset-routes.js';
import type { Env, ServerOptions } from '../types.js';

export function createAssetsApp(opts: ServerOptions): Hono<Env> {
	const app = new Hono<Env>();

	const isPersonal = opts.mode === 'personal';
	const ownerFor = (c: Context<Env>) =>
		isPersonal ? asOwnerId(c.req.param('ownerId')!) : asOwnerId('team');

	// Public read mounts first so the deployment's auth middleware (applied
	// at the same prefix) does not intercept GETs for the capability URL.
	app.route('/owners/:ownerId/assets', createAssetPublicRoutes(ownerFor));
	app.route(
		'/owners/:ownerId/assets',
		createAssetAuthedRoutes(ownerFor, opts.mode),
	);

	return app;
}
