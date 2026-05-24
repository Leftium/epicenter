/**
 * Assets sub-app: owner-partitioned URL shapes for the asset CRUD surface.
 *
 * Uniform URL shape across modes:
 *   POST   /owners/:ownerId/assets              authed upload
 *   GET    /owners/:ownerId/assets              authed list
 *   GET    /owners/:ownerId/assets/usage        authed usage
 *   PATCH  /owners/:ownerId/assets/:assetId     authed metadata update
 *                                                (visibility flip; future:
 *                                                 rename)
 *   DELETE /owners/:ownerId/assets/:assetId     authed delete
 *   GET    /owners/:ownerId/assets/:assetId     CONDITIONAL auth
 *
 * The conditional GET is the one shape that's new. The handler looks up
 * the row, branches on `visibility`:
 *   - 'public'  : serve bytes; no auth required.
 *   - 'private' : require an authenticated session whose actor matches
 *                 the URL `:ownerId` (personal mode) or any team session
 *                 if the URL owner is `TEAM_OWNER_ID` (team mode).
 *
 * Because the conditional GET handles its own auth, the deployment must
 * NOT layer `requireCookieOrBearerUser` upstream of it (that would block
 * public reads). The deployment composes auth on the other methods
 * separately. See `apps/api/src/index.ts` for the split mount.
 *
 * All writes still arrive with `c.var.ownerId` populated by the
 * deployment-mounted `attachOwner` middleware. The conditional read
 * does NOT have `c.var.ownerId` (no attachOwner upstream); it reads
 * `c.req.param('ownerId')` directly and constrains the DB lookup by it.
 *
 * R2 bucket is private (no public domain, no r2.dev). All reads are
 * proxied through this Worker, which sets security headers and supports
 * ETag/range. The library is billing-agnostic and only enforces the
 * platform-level limit {@link MAX_ASSET_BYTES}.
 */

import { asOwnerId, TEAM_OWNER_ID } from '@epicenter/constants/identity';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { customAlphabet } from 'nanoid';
import { defineErrors } from 'wellcrafted/error';
import { MAX_ASSET_BYTES } from '../constants.js';
import * as schema from '../db/schema/index.js';
import { assetKey } from '../owner.js';
import type { Env, OwnershipMode, ServerOptions } from '../types.js';

/**
 * 21-char alphanumeric ID generator (~108 bits entropy). Used as the
 * unguessable credential portion of public asset URLs. Bumped from 15
 * chars after grounding against Signal/Bitwarden precedent and the
 * historical Slack file-token brute-force incident.
 *
 * Inlined here (rather than re-using `@epicenter/workspace`'s
 * `generateGuid`) to avoid pulling Yjs into the Cloudflare Worker
 * bundle.
 */
const generateAssetId = customAlphabet(
	'abcdefghijklmnopqrstuvwxyz0123456789',
	21,
);

const ASSET_ID_REGEX = '[a-z0-9]{21}';

const ALLOWED_MIME_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'application/pdf',
]);

const AssetError = defineErrors({
	MissingFile: () => ({
		message: 'Missing file field in multipart body',
	}),
	InvalidVisibility: ({ value }: { value: string }) => ({
		message: `Invalid visibility: '${value}'. Expected 'private' or 'public'.`,
		value,
	}),
	FileTypeNotAllowed: ({ contentType }: { contentType: string }) => ({
		message: `File type not allowed: ${contentType}`,
		contentType,
		allowed: [...ALLOWED_MIME_TYPES],
	}),
	FileTooLarge: ({ size }: { size: number }) => ({
		message: `File exceeds ${MAX_ASSET_BYTES} byte limit (got ${size})`,
		size,
	}),
	NotFound: () => ({
		message: 'Asset not found',
	}),
	Unauthorized: () => ({
		message: 'Authentication required to read this asset',
	}),
});

function sanitizeFilename(name: string): string {
	return Array.from(name)
		.filter((ch) => {
			const code = ch.charCodeAt(0);
			return code > 0x1f && code !== 0x7f;
		})
		.join('')
		.replaceAll('"', "'")
		.trim()
		.slice(0, 255);
}

function parseVisibility(raw: unknown): 'private' | 'public' | null {
	if (raw === undefined || raw === null || raw === '') return 'private';
	if (raw === 'private' || raw === 'public') return raw;
	return null;
}

/**
 * Authenticated asset CRUD surface, mounted under `/owners/:ownerId/assets`.
 *
 * Every handler in this factory expects `c.var.ownerId` to be populated
 * by the deployment-mounted `attachOwner` middleware. The deployment
 * also runs auth + `requireUrlOwnerIdMatchesAuth` upstream so handlers
 * stay mode-blind for partition resolution.
 */
function createAssetAuthedRoutes(): Hono<Env> {
	return (
		new Hono<Env>()
			// POST / - Create (upload)
			.post(
				'/',
				describeRoute({
					description: 'Upload an asset (image or PDF)',
					tags: ['assets'],
				}),
				bodyLimit({ maxSize: MAX_ASSET_BYTES }),
				async (c) => {
					const body = await c.req.parseBody();
					const file = body.file;
					if (!(file instanceof File)) {
						return c.json(AssetError.MissingFile(), 400);
					}

					const visibility = parseVisibility(body.visibility);
					if (visibility === null) {
						return c.json(
							AssetError.InvalidVisibility({ value: String(body.visibility) }),
							400,
						);
					}

					const sanitizedFilename = sanitizeFilename(file.name);

					if (!ALLOWED_MIME_TYPES.has(file.type)) {
						return c.json(
							AssetError.FileTypeNotAllowed({ contentType: file.type }),
							415,
						);
					}

					if (file.size > MAX_ASSET_BYTES) {
						return c.json(AssetError.FileTooLarge({ size: file.size }), 413);
					}

					const assetId = generateAssetId();
					const r2Key = assetKey(c.var.ownerId, assetId);

					await c.env.ASSETS_BUCKET.put(r2Key, file.stream(), {
						httpMetadata: {
							contentType: file.type,
							contentDisposition: `inline; filename="${sanitizedFilename}"`,
							cacheControl: 'private, max-age=31536000, immutable',
						},
					});

					try {
						await c.var.db.insert(schema.asset).values({
							id: assetId,
							ownerId: c.var.ownerId,
							contentType: file.type,
							sizeBytes: file.size,
							originalName: sanitizedFilename,
							visibility,
						});
					} catch (dbError) {
						// Compensating delete - don't leave orphaned R2 objects
						await c.env.ASSETS_BUCKET.delete(r2Key).catch(() => undefined);
						throw dbError;
					}

					return c.json(
						{
							id: assetId,
							url: `${c.req.path.replace(/\/$/, '')}/${assetId}`,
							visibility,
							contentType: file.type,
							size: file.size,
							originalName: sanitizedFilename,
						},
						201,
					);
				},
			)
			// GET / - List the current owner's assets
			.get(
				'/',
				describeRoute({
					description: "List the current owner's assets",
					tags: ['assets'],
				}),
				async (c) => {
					const assets = await c.var.db
						.select()
						.from(schema.asset)
						.where(eq(schema.asset.ownerId, c.var.ownerId))
						.orderBy(desc(schema.asset.uploadedAt))
						.limit(100);
					return c.json(assets);
				},
			)
			// GET /usage - Total storage in bytes
			.get(
				'/usage',
				describeRoute({
					description: "Get the current owner's total storage usage in bytes",
					tags: ['assets'],
				}),
				async (c) => {
					const result = await c.var.db
						.select({
							total: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
						})
						.from(schema.asset)
						.where(eq(schema.asset.ownerId, c.var.ownerId));
					const total = result[0]?.total ?? 0;
					return c.json({ totalBytes: total });
				},
			)
			// PATCH /:assetId - Modify metadata (currently: visibility only)
			.patch(
				`/:assetId{${ASSET_ID_REGEX}}`,
				describeRoute({
					description:
						"Modify an asset's metadata (currently: visibility flip)",
					tags: ['assets'],
				}),
				async (c) => {
					const { assetId } = c.req.param();
					const body = await c.req.json().catch(() => null);
					const visibility = parseVisibility(body?.visibility);
					if (visibility === null) {
						return c.json(
							AssetError.InvalidVisibility({
								value: String(body?.visibility),
							}),
							400,
						);
					}

					const [updated] = await c.var.db
						.update(schema.asset)
						.set({ visibility })
						.where(
							and(
								eq(schema.asset.id, assetId),
								eq(schema.asset.ownerId, c.var.ownerId),
							),
						)
						.returning({
							id: schema.asset.id,
							visibility: schema.asset.visibility,
						});

					if (!updated) {
						return c.json(AssetError.NotFound(), 404);
					}
					return c.json(updated);
				},
			)
			// DELETE /:assetId - Delete (owner only)
			.delete(
				`/:assetId{${ASSET_ID_REGEX}}`,
				describeRoute({
					description: 'Delete an asset (owner only)',
					tags: ['assets'],
				}),
				async (c) => {
					const { assetId } = c.req.param();

					const [deleted] = await c.var.db
						.delete(schema.asset)
						.where(
							and(
								eq(schema.asset.id, assetId),
								eq(schema.asset.ownerId, c.var.ownerId),
							),
						)
						.returning({ sizeBytes: schema.asset.sizeBytes });

					if (!deleted) {
						return c.json(AssetError.NotFound(), 404);
					}

					await c.env.ASSETS_BUCKET.delete(assetKey(c.var.ownerId, assetId));
					// Surface deleted byte count via response header so cloud's
					// storage gate can refund without re-reading the row.
					return c.body(null, 204, {
						'x-deleted-size-bytes': String(deleted.sizeBytes),
					});
				},
			)
	);
}

/**
 * Conditional asset read. Mounted at `/owners/:ownerId/assets`. The
 * deployment must NOT layer auth upstream of this route, because public
 * reads bypass auth by design. The handler looks up the row, branches
 * on `visibility`, and runs an auth check inline only for private
 * assets.
 *
 * `mode` is needed because the actor-matches-owner check differs by
 * deployment: personal mode requires `session.user.id === urlOwnerId`;
 * team mode requires only that a session exists (the URL owner is
 * pinned to `TEAM_OWNER_ID` by the route shape).
 */
function createAssetReadRoute(mode: OwnershipMode): Hono<Env> {
	return new Hono<Env>().get(
		`/:assetId{${ASSET_ID_REGEX}}`,
		describeRoute({
			description:
				'Read an asset by ID. Public assets serve without auth; private assets require an authenticated owner.',
			tags: ['assets'],
		}),
		async (c) => {
			const { assetId } = c.req.param();
			const urlOwnerId = asOwnerId(c.req.param('ownerId')!);

			const [row] = await c.var.db
				.select({
					visibility: schema.asset.visibility,
				})
				.from(schema.asset)
				.where(
					and(
						eq(schema.asset.id, assetId),
						eq(schema.asset.ownerId, urlOwnerId),
					),
				)
				.limit(1);

			if (!row) return c.json(AssetError.NotFound(), 404);

			if (row.visibility === 'private') {
				const session = await c.var.auth.api.getSession({
					headers: c.req.raw.headers,
				});
				const authorized =
					session != null &&
					(mode === 'team'
						? urlOwnerId === TEAM_OWNER_ID
						: session.user.id === urlOwnerId);
				if (!authorized) return c.json(AssetError.Unauthorized(), 401);
			}

			const object = await c.env.ASSETS_BUCKET.get(
				assetKey(urlOwnerId, assetId),
				{
					onlyIf: c.req.raw.headers,
					range: c.req.raw.headers,
				},
			);

			if (object === null) {
				return c.body('Not found', 404);
			}

			// Bodyless object - precondition failed (ETag match -> 304)
			if (!('body' in object)) {
				const headers = new Headers();
				object.writeHttpMetadata(headers);
				headers.set('etag', object.httpEtag);
				headers.set('referrer-policy', 'no-referrer');
				return new Response(null, { status: 304, headers });
			}

			// Build response headers
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			headers.set('accept-ranges', 'bytes');
			headers.set('x-content-type-options', 'nosniff');
			// Capability URL: do not let outgoing sub-resource requests carry
			// the asset URL as a Referer. The unguessable id is the credential;
			// keep it out of third-party logs and analytics.
			headers.set('referrer-policy', 'no-referrer');
			if (object.uploaded) {
				headers.set('last-modified', object.uploaded.toUTCString());
			}

			// Range request -> 206
			const range = object.range;
			if (range) {
				let start: number;
				let end: number;
				if ('suffix' in range) {
					const len = Math.min(range.suffix, object.size);
					start = object.size - len;
					end = object.size - 1;
				} else {
					start = range.offset ?? 0;
					end =
						range.length != null
							? Math.min(start + range.length - 1, object.size - 1)
							: object.size - 1;
				}
				headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
				headers.set('content-length', String(end - start + 1));
				return new Response(object.body, { status: 206, headers });
			}

			headers.set('content-length', String(object.size));
			return new Response(object.body, { status: 200, headers });
		},
	);
}

export function createAssetsApp(opts: ServerOptions): Hono<Env> {
	const app = new Hono<Env>();
	// Conditional read mounts first so it matches GET /:assetId before
	// any wildcard handlers. Order matters: both sub-apps mount at the
	// same prefix, and Hono matches in registration order.
	app.route('/owners/:ownerId/assets', createAssetReadRoute(opts.mode));
	app.route('/owners/:ownerId/assets', createAssetAuthedRoutes());
	return app;
}
