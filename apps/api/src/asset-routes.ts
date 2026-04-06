/**
 * Asset upload, read, and delete routes.
 *
 * Upload and delete require authentication + paid plan. Read is unauthenticated—
 * the unguessable URL (two 15-char nanoids) is the credential, same model as
 * Google Drive "anyone with the link", Discord CDN, and Supabase Storage.
 *
 * R2 bucket is private (no public domain, no r2.dev). All reads are proxied
 * through this Worker, which sets security headers and supports ETag/range.
 */

import { generateGuid } from '@epicenter/workspace';
import { and, desc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import type { Env } from './app.js';
import { createAutumn } from './autumn.js';
import { FEATURE_IDS } from './billing-plans.js';
import { MAX_ASSET_BYTES } from './constants.js';
import * as schema from './db/schema.js';

const ALLOWED_MIME_TYPES = new Set([
	'image/png',
	'image/jpeg',
	'image/gif',
	'image/webp',
	'application/pdf',
]);

async function detectMimeType(file: File): Promise<string | null> {
	const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());

	if (
		bytes.length >= 4 &&
		bytes[0] === 0x89 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x4e &&
		bytes[3] === 0x47
	) {
		return 'image/png';
	}

	if (
		bytes.length >= 3 &&
		bytes[0] === 0xff &&
		bytes[1] === 0xd8 &&
		bytes[2] === 0xff
	) {
		return 'image/jpeg';
	}

	if (
		bytes.length >= 4 &&
		bytes[0] === 0x47 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x38
	) {
		return 'image/gif';
	}

	if (
		bytes.length >= 12 &&
		bytes[0] === 0x52 &&
		bytes[1] === 0x49 &&
		bytes[2] === 0x46 &&
		bytes[3] === 0x46 &&
		bytes[8] === 0x57 &&
		bytes[9] === 0x45 &&
		bytes[10] === 0x42 &&
		bytes[11] === 0x50
	) {
		return 'image/webp';
	}

	if (
		bytes.length >= 4 &&
		bytes[0] === 0x25 &&
		bytes[1] === 0x50 &&
		bytes[2] === 0x44 &&
		bytes[3] === 0x46
	) {
		return 'application/pdf';
	}

	return null;
}

function sanitizeFilename(name: string): string {
	const withoutControlCharacters = Array.from(name)
		.filter((character) => {
			const code = character.charCodeAt(0);
			return !(code <= 0x1f || code === 0x7f);
		})
		.join('');

	return withoutControlCharacters.replaceAll('"', "'").trim().slice(0, 255);
}

// ---------------------------------------------------------------------------
// Sub-routers: separate auth'd and public routes
// ---------------------------------------------------------------------------

/** Authenticated routes (upload + delete). Mounted behind authGuard in app.ts. */
export const assetAuthedRoutes = new Hono<Env>();

/** Public routes (read). Mounted without authGuard in app.ts. */
export const assetPublicRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// POST / — Upload
// ---------------------------------------------------------------------------

assetAuthedRoutes.post(
	'/',
	describeRoute({
		description: 'Upload an asset (image or PDF)',
		tags: ['assets'],
	}),
	bodyLimit({ maxSize: MAX_ASSET_BYTES }),
	async (c) => {
		// -- Storage billing gate --
		const autumn = createAutumn(c.env);
		await autumn.customers.getOrCreate({
			customerId: c.var.user.id,
			name: c.var.user.name ?? undefined,
			email: c.var.user.email ?? undefined,
		});

		// -- Extract file from multipart body --
		const body = await c.req.parseBody();
		const file = body.file;
		if (!(file instanceof File)) {
			return c.json({ error: 'Missing file field in multipart body' }, 400);
		}

		const detectedMimeType = await detectMimeType(file);
		const sanitizedFilename = sanitizeFilename(file.name);

		// -- Validate MIME type --
		if (
			detectedMimeType === null ||
			!ALLOWED_MIME_TYPES.has(detectedMimeType)
		) {
			return c.json(
				{
					error: 'File type not allowed',
					allowed: [...ALLOWED_MIME_TYPES],
				},
				415,
			);
		}

		// -- Validate size (belt-and-suspenders with bodyLimit) --
		if (file.size > MAX_ASSET_BYTES) {
			return c.json({ error: 'File too large' }, 413);
		}

		// -- Check storage allowance before writing --
		const { allowed } = await autumn.check({
			customerId: c.var.user.id,
			featureId: FEATURE_IDS.storageBytes,
			requiredBalance: file.size,
		});
		if (!allowed) {
			return c.json({ error: 'Storage limit exceeded' }, 402);
		}

		// -- Store in R2 + Postgres --
		const assetId = generateGuid();
		const key = `${c.var.user.id}/${assetId}`;

		await c.env.ASSETS_BUCKET.put(key, file.stream(), {
			httpMetadata: {
				contentType: detectedMimeType,
				contentDisposition: `inline; filename="${sanitizedFilename}"`,
				cacheControl: 'private, max-age=31536000, immutable',
			},
		});

		try {
			await c.var.db.insert(schema.asset).values({
				id: assetId,
				userId: c.var.user.id,
				contentType: detectedMimeType,
				sizeBytes: file.size,
				originalName: sanitizedFilename,
			});
		} catch (dbError) {
			// Compensating delete — don't leave orphaned R2 objects
			await c.env.ASSETS_BUCKET.delete(key).catch((r2Err) =>
				console.error('[upload] R2 cleanup failed:', r2Err),
			);
			throw dbError;
		}

		// Track storage usage (fire-and-forget after response)
		c.var.afterResponse.push(
			autumn.track({
				customerId: c.var.user.id,
				featureId: FEATURE_IDS.storageBytes,
				value: file.size,
			}),
		);

		return c.json(
			{
				id: assetId,
				url: `/api/assets/${c.var.user.id}/${assetId}`,
				contentType: detectedMimeType,
				size: file.size,
				originalName: sanitizedFilename,
			},
			201,
		);
	},
);

// ---------------------------------------------------------------------------
// GET / — List current user's assets (paginated)
// ---------------------------------------------------------------------------

assetAuthedRoutes.get(
	'/',
	describeRoute({
		description: "List the current user's assets",
		tags: ['assets'],
	}),
	async (c) => {
		const assets = await c.var.db
			.select()
			.from(schema.asset)
			.where(eq(schema.asset.userId, c.var.user.id))
			.orderBy(desc(schema.asset.uploadedAt))
			.limit(100);

		return c.json(assets);
	},
);

// ---------------------------------------------------------------------------
// GET /usage — Current user's total storage in bytes
// ---------------------------------------------------------------------------

assetAuthedRoutes.get(
	'/usage',
	describeRoute({
		description: "Get the current user's total storage usage in bytes",
		tags: ['assets'],
	}),
	async (c) => {
		const result = await c.var.db
			.select({
				total: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
			})
			.from(schema.asset)
			.where(eq(schema.asset.userId, c.var.user.id));
		const total = result[0]?.total ?? 0;

		return c.json({ totalBytes: total });
	},
);
// ---------------------------------------------------------------------------
// DELETE /:userId/:assetId — Delete (authenticated, owner only)
// ---------------------------------------------------------------------------

assetAuthedRoutes.delete(
	'/:userId/:assetId',
	describeRoute({
		description: 'Delete an asset (owner only)',
		tags: ['assets'],
	}),
	async (c) => {
		const { assetId } = c.req.param();

		// Atomic lookup + delete scoped by authenticated user
		const [deleted] = await c.var.db
			.delete(schema.asset)
			.where(
				and(
					eq(schema.asset.id, assetId),
					eq(schema.asset.userId, c.var.user.id),
				),
			)
			.returning({ sizeBytes: schema.asset.sizeBytes });

		if (!deleted) {
			return c.json({ error: 'Asset not found' }, 404);
		}

		const key = `${c.var.user.id}/${assetId}`;
		await c.env.ASSETS_BUCKET.delete(key);

		// Credit storage back (fire-and-forget after response)
		const autumn = createAutumn(c.env);
		c.var.afterResponse.push(
			autumn.track({
				customerId: c.var.user.id,
				featureId: FEATURE_IDS.storageBytes,
				value: -deleted.sizeBytes,
			}),
		);

		return c.body(null, 204);
	},
);
// ---------------------------------------------------------------------------
// POST /reconcile — Manual storage billing reconciliation (admin)
// ---------------------------------------------------------------------------

assetAuthedRoutes.post(
	'/reconcile',
	describeRoute({
		description: 'Reconcile storage billing with Postgres totals',
		tags: ['assets', 'admin'],
	}),
	async (c) => {
		// Admin gate — only allowed user IDs can trigger reconciliation
		const adminIds = (c.env.ADMIN_USER_IDS ?? '').split(',').filter(Boolean);
		if (!adminIds.includes(c.var.user.id)) {
			return c.json({ error: 'Forbidden' }, 403);
		}
		// Left join from user → asset to include users with zero assets.
		// Without this, users who deleted all assets keep stale billing.
		const userTotals = await c.var.db
			.select({
				userId: schema.user.id,
				totalBytes: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
			})
			.from(schema.user)
			.leftJoin(schema.asset, eq(schema.user.id, schema.asset.userId))
			.groupBy(schema.user.id);

		let errors = 0;
		const secretKey = c.env.AUTUMN_SECRET_KEY;
		const batchSize = 10;

		// Process in batches of 10 to avoid timeout on large user sets
		for (let i = 0; i < userTotals.length; i += batchSize) {
			const batch = userTotals.slice(i, i + batchSize);
			const results = await Promise.allSettled(
				batch.map(({ userId, totalBytes }) =>
					fetch('https://api.useautumn.com/v1/usage', {
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							Authorization: `Bearer ${secretKey}`,
						},
						body: JSON.stringify({
							customer_id: userId,
							feature_id: FEATURE_IDS.storageBytes,
							value: totalBytes,
						}),
					}).then(async (res) => {
						if (!res.ok) {
							const body = await res.text();
							throw new Error(`Autumn /usage (${res.status}): ${body}`);
						}
					}),
				),
			);
			errors += results.filter((r) => r.status === 'rejected').length;
		}

		return c.json({ usersProcessed: userTotals.length, errors });
	},
);

// ---------------------------------------------------------------------------
// GET /:userId/:assetId — Read (unauthenticated, unguessable URL)
// ---------------------------------------------------------------------------

assetPublicRoutes.get(
	'/:userId/:assetId',
	describeRoute({
		description: 'Read an asset by ID (unauthenticated)',
		tags: ['assets'],
	}),
	async (c) => {
		const { userId, assetId } = c.req.param();
		const key = `${userId}/${assetId}`;

		// Only forward cache-revalidation headers so bodyless response
		// unambiguously means 304 (not 412 from If-Match/If-Unmodified-Since).
		const onlyIf: Record<string, string> = {};
		const inm = c.req.raw.headers.get('if-none-match');
		const ims = c.req.raw.headers.get('if-modified-since');
		if (inm) onlyIf.etagDoesNotMatch = inm;
		if (ims) onlyIf.uploadedBefore = ims;

		const object = await c.env.ASSETS_BUCKET.get(key, {
			onlyIf: Object.keys(onlyIf).length > 0 ? onlyIf : undefined,
			range: c.req.raw.headers,
		});

		// No object at all → 404
		if (object === null) {
			return c.body('Not found', 404);
		}

		// Object exists but no body → precondition failed (ETag matched)
		if (!('body' in object)) {
			const headers = new Headers();
			object.writeHttpMetadata(headers);
			headers.set('etag', object.httpEtag);
			return new Response(null, { status: 304, headers });
		}

		// Build response headers from stored httpMetadata
		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('accept-ranges', 'bytes');
		headers.set('x-content-type-options', 'nosniff');
		if (object.uploaded) {
			headers.set('last-modified', object.uploaded.toUTCString());
		}

		// Range request → 206 with content-range header
		const range = object.range;
		if (range) {
			let start: number;
			let end: number;
			if ('suffix' in range) {
				// bytes=-N → last N bytes
				const len = Math.min(range.suffix, object.size);
				start = object.size - len;
				end = object.size - 1;
			} else {
				start = range.offset ?? 0;
				// Clamp to actual object size
				end = range.length != null
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
