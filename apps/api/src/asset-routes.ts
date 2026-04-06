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
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { describeRoute } from 'hono-openapi';
import type { Env } from './app.js';
import { createAutumn } from './autumn.js';
import { PLAN_IDS } from './billing-plans.js';
import { MAX_ASSET_BYTES } from './constants.js';

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
const authedRoutes = new Hono<Env>();

/** Public routes (read). Mounted without authGuard in app.ts. */
const publicRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// POST / — Upload
// ---------------------------------------------------------------------------

authedRoutes.post(
	'/',
	describeRoute({
		description: 'Upload an asset (image or PDF)',
		tags: ['assets'],
	}),
	bodyLimit({ maxSize: MAX_ASSET_BYTES }),
	async (c) => {
		// -- Plan gate: paid users only --
		const autumn = createAutumn(c.env);
		const customer = await autumn.customers.getOrCreate({
			customerId: c.var.user.id,
			name: c.var.user.name ?? undefined,
			email: c.var.user.email ?? undefined,
			expand: ['subscriptions.plan'],
		});
		const mainSub = customer.subscriptions?.find(
			(s: { addOn?: boolean }) => !s.addOn,
		);
		const planId = mainSub?.planId ?? 'free';
		if (planId === PLAN_IDS.free) {
			return c.json({ error: 'Paid plan required for asset uploads' }, 402);
		}

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

		// -- Store in R2 --
		const assetId = generateGuid();
		const key = `${c.var.user.id}/${assetId}`;

		await c.env.ASSETS_BUCKET.put(key, file.stream(), {
			httpMetadata: {
				contentType: file.type,
				contentDisposition: `inline; filename="${file.name}"`,
				cacheControl: 'private, max-age=31536000, immutable',
			},
			customMetadata: {
				originalName: file.name,
				userId: c.var.user.id,
				uploadedAt: new Date().toISOString(),
			},
		});

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
// DELETE /:userId/:assetId — Delete (authenticated, owner only)
// ---------------------------------------------------------------------------

authedRoutes.delete(
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

		const key = `${userId}/${assetId}`;
		await c.env.ASSETS_BUCKET.delete(key);

		return c.body(null, 204);
	},
);

// ---------------------------------------------------------------------------
// GET /:userId/:assetId — Read (unauthenticated, unguessable URL)
// ---------------------------------------------------------------------------

publicRoutes.get(
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
		if (!('body' in object && object.body)) {
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
		const hasRange = 'range' in object && object.range;
		const status = hasRange ? 206 : 200;
		if (hasRange && 'offset' in object.range!) {
			const start = object.range!.offset ?? 0;
			const end = object.range!.length
				? start + object.range!.length - 1
				: object.size - 1;
			headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
			headers.set('content-length', String(end - start + 1));
		}

		return new Response(object.body, { status, headers });
	},
);

export { authedRoutes as assetAuthedRoutes, publicRoutes as assetPublicRoutes };
