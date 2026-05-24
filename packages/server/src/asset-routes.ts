/**
 * Asset routes: authenticated upload, list, usage, delete, plus an
 * unauthenticated read.
 *
 * Upload and delete require authentication. Read is unauthenticated: the
 * unguessable URL (15-char nanoid) is the credential, same model as Google
 * Drive "anyone with the link", Discord CDN, and Supabase Storage.
 *
 * R2 bucket is private (no public domain, no r2.dev). All reads are proxied
 * through this Worker, which sets security headers and supports ETag/range.
 *
 * Billing concerns (storage quota checks, usage tracking, reconciliation)
 * are layered on top by the cloud deployment via Hono middleware; the
 * library is billing-agnostic and only enforces the platform-level
 * limit {@link MAX_ASSET_BYTES}.
 */

import { customAlphabet } from 'nanoid';

/**
 * 15-char alphanumeric ID generator - same spec as `generateGuid` in @epicenter/workspace.
 * Inlined here to avoid pulling workspace (and its Yjs dependency tree) into the
 * Cloudflare Worker bundle, where wrangler can't resolve it.
 */
const generateGuid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 15);

import { and, desc, eq, sql } from 'drizzle-orm';
import type { OwnerId, OwnershipMode } from '@epicenter/auth';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import { defineErrors } from 'wellcrafted/error';
import { MAX_ASSET_BYTES } from './constants.js';
import * as schema from './db/schema/index.js';
import { assetKey } from './owner.js';
import type { Env } from './types.js';

const ALLOWED_MIME_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'application/pdf',
]);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const AssetError = defineErrors({
	MissingFile: () => ({
		message: 'Missing file field in multipart body',
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

/**
 * Build a `Hono` sub-app exposing the authenticated asset CRUD surface.
 *
 * URL shape is uniform across modes: handlers mount under
 * `/owners/:ownerId/assets`. In personal mode the deployment layers
 * `requireUrlOwnerIdMatchesAuth` so `:ownerId === c.var.user.id`; in team
 * mode `:ownerId` is the literal `'team'`. `ownerFor(c)` returns the
 * resolved `OwnerId`. Per-row filtering happens only in personal mode
 * (gated by `mode`), because in team mode every member shares the same
 * `ownerId === 'team'` partition.
 */
type OwnerForContext = (c: import('hono').Context<Env>) => OwnerId;

export function createAssetAuthedRoutes(
	ownerFor: OwnerForContext,
	mode: OwnershipMode,
): Hono<Env> {
	const isPersonal = mode === 'personal';
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

					// The R2 key is the partition-prefixed `owners/<ownerId>/assets/<assetId>`.
					// Personal mode: `owners/<userId>/assets/<assetId>`.
					// Team mode:     `owners/team/assets/<assetId>`.
					// Provenance (asset.userId) is still recorded for both modes so
					// deletion via account-delete can find every object.
					const assetId = generateGuid();
					const ownerId = ownerFor(c);
					const r2Key = assetKey(ownerId, assetId);

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
							userId: c.var.user.id,
							contentType: file.type,
							sizeBytes: file.size,
							originalName: sanitizedFilename,
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
					const ownerId = ownerFor(c);
					// Personal mode scopes by the actor (ownerId === userId in this
					// mode). Team mode shares one partition, so no per-row filter.
					const filter = isPersonal
						? eq(schema.asset.userId, ownerId)
						: undefined;
					const query = c.var.db
						.select()
						.from(schema.asset)
						.orderBy(desc(schema.asset.uploadedAt))
						.limit(100);
					const assets = await (filter ? query.where(filter) : query);
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
					const ownerId = ownerFor(c);
					const filter = isPersonal
						? eq(schema.asset.userId, ownerId)
						: undefined;
					const query = c.var.db
						.select({
							total: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
						})
						.from(schema.asset);
					const result = await (filter ? query.where(filter) : query);
					const total = result[0]?.total ?? 0;
					return c.json({ totalBytes: total });
				},
			)
			// DELETE /:assetId - Delete (owner only)
			.delete(
				'/:assetId{[a-z0-9]{15}}',
				describeRoute({
					description: 'Delete an asset (owner only)',
					tags: ['assets'],
				}),
				async (c) => {
					const { assetId } = c.req.param();
					const ownerId = ownerFor(c);

					// Atomic lookup + delete. Personal mode scopes to the
					// authenticated user; team mode trusts the URL alone.
					const filter = isPersonal
						? and(
								eq(schema.asset.id, assetId),
								eq(schema.asset.userId, ownerId),
							)
						: eq(schema.asset.id, assetId);
					const [deleted] = await c.var.db
						.delete(schema.asset)
						.where(filter)
						.returning({ sizeBytes: schema.asset.sizeBytes });

					if (!deleted) {
						return c.json(AssetError.NotFound(), 404);
					}

					await c.env.ASSETS_BUCKET.delete(assetKey(ownerId, assetId));
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
 * Build a `Hono` sub-app exposing the public asset read.
 *
 * The unguessable 15-char id is the credential, so the route ships
 * unauthenticated. The asset id is constrained to the exact pattern
 * `generateGuid` produces so it cannot shadow sibling management endpoints
 * mounted under the same `/assets` prefix.
 */
export function createAssetPublicRoutes(ownerFor: OwnerForContext): Hono<Env> {
	return new Hono<Env>().get(
		'/:assetId{[a-z0-9]{15}}',
		describeRoute({
			description: 'Read an asset by ID (unauthenticated)',
			tags: ['assets'],
		}),
		async (c) => {
			const { assetId } = c.req.param();
			const ownerId = ownerFor(c);

			const object = await c.env.ASSETS_BUCKET.get(
				assetKey(ownerId, assetId),
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
