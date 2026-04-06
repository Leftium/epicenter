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
import { desc, eq, sql } from 'drizzle-orm';
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

		// -- Validate MIME type --
		if (!ALLOWED_MIME_TYPES.has(file.type)) {
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

		// -- Store in R2 --
		const assetId = generateGuid();
		const key = `${c.var.user.id}/${assetId}`;
		await c.env.ASSETS_BUCKET.put(key, file.stream(), {
			httpMetadata: {
				contentType: file.type,
				contentDisposition: `inline; filename="${file.name}"`,
				cacheControl: 'private, max-age=31536000, immutable',
			},
		});

		// Insert metadata row — Postgres is the source of truth for billing/listing
		await c.var.db.insert(schema.asset).values({
			id: assetId,
			userId: c.var.user.id,
			contentType: file.type,
			sizeBytes: file.size,
			originalName: file.name,
		});

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
				contentType: file.type,
				size: file.size,
				originalName: file.name,
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
		const { userId, assetId } = c.req.param();

		// Owner check
		if (c.var.user.id !== userId) {
			return c.json({ error: 'Forbidden' }, 403);
		}

		// Look up asset to get sizeBytes for billing credit
		const [row] = await c.var.db
			.select({ sizeBytes: schema.asset.sizeBytes })
			.from(schema.asset)
			.where(eq(schema.asset.id, assetId))
			.limit(1);

		if (!row) {
			return c.json({ error: 'Asset not found' }, 404);
		}

		const key = `${userId}/${assetId}`;
		await c.env.ASSETS_BUCKET.delete(key);
		await c.var.db.delete(schema.asset).where(eq(schema.asset.id, assetId));

		// Credit storage back (fire-and-forget after response)
		const autumn = createAutumn(c.env);
		c.var.afterResponse.push(
			autumn.track({
				customerId: c.var.user.id,
				featureId: FEATURE_IDS.storageBytes,
				value: -row.sizeBytes,
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
		const userTotals = await c.var.db
			.select({
				userId: schema.asset.userId,
				totalBytes: sql<number>`COALESCE(SUM(${schema.asset.sizeBytes}), 0)`,
			})
			.from(schema.asset)
			.groupBy(schema.asset.userId);

		let errors = 0;
		const secretKey = c.env.AUTUMN_SECRET_KEY;

		for (const { userId, totalBytes } of userTotals) {
			try {
				const res = await fetch('https://api.useautumn.com/v1/usage', {
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
				});
				if (!res.ok) {
					const body = await res.text();
					throw new Error(`Autumn /usage failed (${res.status}): ${body}`);
				}
			} catch (e) {
				console.error(`[reconciliation] Failed for user ${userId}:`, e);
				errors++;
			}
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

		const object = await c.env.ASSETS_BUCKET.get(key, {
			onlyIf: c.req.raw.headers,
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
		headers.set('x-content-type-options', 'nosniff');

		// Range request → 206 with content-range header
		const range = object.range;
		const status = range ? 206 : 200;
		if (range && 'offset' in range) {
			const start = range.offset ?? 0;
		const end = range.length != null
			? start + range.length - 1
			: object.size - 1;
			headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
			headers.set('content-length', String(end - start + 1));
		}

		return new Response(object.body, { status, headers });
	},
);

