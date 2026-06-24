/**
 * One-scenario smoke test for the runtime port. Same backend, either runtime.
 *
 * Point it at a base URL and it runs ONE end-to-end scenario against the live
 * HTTP server: mint a credential, read the session, open a room, and exercise
 * the full content-addressed blob lifecycle (ticket -> presigned PUT -> read
 * back -> usage). Every step prints a single PASS/FAIL/SKIP line, so the same
 * invocation against the Bun process (:8788) and the wrangler process (:8787)
 * produces a diffable transcript of runtime parity.
 *
 *   bun apps/api/scripts/smoke.ts http://localhost:8788   # Bun runtime port
 *   bun apps/api/scripts/smoke.ts http://localhost:8787   # wrangler dev
 *
 * Auth is the only thing the scenario cannot get over plain HTTP: email/password
 * is disabled and Google is interactive (base-config.ts). So this builds a
 * throwaway Better Auth instance against the SAME Postgres the server reads,
 * seeds a user + session through Better Auth's own internal adapter (a raw SQL
 * insert is not enough — the server's `findSession` join only resolves rows the
 * adapter created), and signs the session cookie with `makeSignature` +
 * `encodeURIComponent` (the exact cookie scheme better-call ships). That cookie
 * unlocks the cookie-or-bearer surfaces (session, blobs). Rooms is bearer-only,
 * so the script best-effort upgrades the cookie to a real OAuth access token
 * through the live authorize/token flow (reusing the seeded `epicenter-cli`
 * public PKCE client); if that fails (e.g. the client is not seeded, or the
 * server booted with a JWKS-incompatible secret) the room step is SKIPPED with
 * the reason and the rest still runs.
 *
 * Requirements to run:
 *   - BASE_URL reachable (a booted Bun or wrangler server).
 *   - DATABASE_URL pointing at the SAME Postgres the server uses.
 *   - BETTER_AUTH_SECRET equal to the server's secret (the cookie signature and
 *     the server's verification must agree).
 *   - For a full green blob round-trip the server must have BLOBS_S3_* set;
 *     without object storage the blob routes answer 503 and the script reports
 *     that as an expected, non-fatal outcome.
 *
 * This script writes only a throwaway user/session (cleaned up at the end) and
 * touches no production config.
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import {
	EPICENTER_CLI_OAUTH_CLIENT_ID,
	EPICENTER_OAUTH_SCOPE,
} from '@epicenter/constants/oauth-clients';
import * as schema from '@epicenter/server/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { makeSignature } from 'better-auth/crypto';
import { generateCodeChallenge } from 'better-auth/oauth2';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	'http://localhost:8788'
).replace(/\/+$/, '');
const DATABASE_URL =
	process.env.DATABASE_URL ??
	'postgres://postgres:postgres@localhost:5432/epicenter';
const SECRET = process.env.BETTER_AUTH_SECRET;

if (!SECRET) {
	console.error(
		'BETTER_AUTH_SECRET is required and must match the running server. Aborting.',
	);
	process.exit(2);
}

// ── tiny step reporter ──────────────────────────────────────────────────────

type Status = 'PASS' | 'FAIL' | 'SKIP';
const rows: { status: Status; step: string; detail: string }[] = [];
function record(status: Status, step: string, detail: string) {
	rows.push({ status, step, detail });
	console.log(`  [${status}] ${step.padEnd(26)} ${detail}`);
}

const randHex = (bytes: number) =>
	[...crypto.getRandomValues(new Uint8Array(bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');

async function sha256Hex(data: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', data as BufferSource);
	return [...new Uint8Array(digest)]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// ── auth: seed a throwaway user + session via Better Auth, sign the cookie ────

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const auth = betterAuth({
	secret: SECRET,
	baseURL: BASE_URL,
	emailAndPassword: { enabled: false },
	database: drizzleAdapter(drizzle(pool, { schema }), {
		provider: 'pg',
		schema,
	}),
});

let seededUserId = '';

async function seedSessionCookie(): Promise<string> {
	const ctx = await auth.$context;
	const user = await ctx.internalAdapter.createUser({
		id: `smoke_${randHex(8)}`,
		name: 'Smoke Test',
		email: `smoke+${randHex(6)}@example.invalid`,
		emailVerified: true,
	});
	seededUserId = user.id;
	const session = await ctx.internalAdapter.createSession(user.id, undefined);
	const signed = `${session.token}.${await makeSignature(session.token, SECRET as string)}`;
	return `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(signed)}`;
}

/**
 * Upgrade the session cookie to a real OAuth access token through the live
 * authorize/token flow, reusing the seeded `epicenter-cli` public PKCE client.
 * Returns null (with a logged reason) if any leg fails, so the caller degrades
 * to cookie-only.
 */
async function mintBearer(cookie: string): Promise<string | null> {
	const { rows: clientRows } = await pool.query<{ redirect_uris: string[] }>(
		`SELECT redirect_uris FROM oauth_client WHERE client_id = $1`,
		[EPICENTER_CLI_OAUTH_CLIENT_ID],
	);
	const redirectUri = clientRows[0]?.redirect_uris?.[0];
	if (!redirectUri) {
		record(
			'SKIP',
			'bearer mint',
			`oauth client '${EPICENTER_CLI_OAUTH_CLIENT_ID}' not seeded (run oauth:seed:local)`,
		);
		return null;
	}

	const verifier = randHex(48);
	const authorizeUrl = new URL(`${BASE_URL}/auth/oauth2/authorize`);
	for (const [k, v] of Object.entries({
		response_type: 'code',
		client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
		redirect_uri: redirectUri,
		scope: EPICENTER_OAUTH_SCOPE,
		state: `smoke-${randHex(4)}`,
		code_challenge: await generateCodeChallenge(verifier),
		code_challenge_method: 'S256',
		resource: BASE_URL,
	})) {
		authorizeUrl.searchParams.set(k, v);
	}

	const authorizeRes = await fetch(authorizeUrl, {
		headers: { cookie },
		redirect: 'manual',
	});
	const location = authorizeRes.headers.get('location');
	const code = location
		? new URL(location, BASE_URL).searchParams.get('code')
		: null;
	if (!code) {
		record(
			'SKIP',
			'bearer mint',
			`authorize returned ${authorizeRes.status} with no code`,
		);
		return null;
	}

	const tokenRes = await fetch(`${BASE_URL}/auth/oauth2/token`, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			client_id: EPICENTER_CLI_OAUTH_CLIENT_ID,
			redirect_uri: redirectUri,
			code,
			code_verifier: verifier,
			resource: BASE_URL,
		}),
	});
	if (!tokenRes.ok) {
		record('SKIP', 'bearer mint', `token endpoint returned ${tokenRes.status}`);
		return null;
	}
	const body = (await tokenRes.json()) as { access_token?: string };
	if (!body.access_token) {
		record('SKIP', 'bearer mint', 'token response had no access_token');
		return null;
	}
	record('PASS', 'bearer mint', 'OAuth access token via authorize/token');
	return body.access_token;
}

async function cleanup() {
	try {
		if (seededUserId) {
			await pool.query(`DELETE FROM "user" WHERE id = $1`, [seededUserId]);
		}
	} catch (err) {
		console.log(`  (cleanup left rows: ${(err as Error).message})`);
	}
	await pool.end();
}

// ── scenario ────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\nSmoke scenario against ${BASE_URL}\n`);

	// 1. Health (no auth) — also reports which runtime answered.
	try {
		const res = await fetch(`${BASE_URL}/`);
		const body = (await res.json()) as { runtime?: string };
		record(
			res.ok ? 'PASS' : 'FAIL',
			'health',
			`${res.status} runtime=${body.runtime ?? '?'}`,
		);
	} catch (err) {
		record('FAIL', 'health', `unreachable: ${(err as Error).message}`);
		await cleanup();
		return summarize();
	}

	// Auth: seed cookie, best-effort upgrade to bearer.
	const cookie = await seedSessionCookie();
	const bearer = await mintBearer(cookie);
	const authHeaders: Record<string, string> = bearer
		? { authorization: `Bearer ${bearer}` }
		: { cookie };

	// 2. Session — resolves the owner partition.
	let ownerId = '';
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: authHeaders,
		});
		if (res.ok) {
			ownerId = ((await res.json()) as { ownerId: string }).ownerId;
			record('PASS', 'session', `${res.status} ownerId=${ownerId}`);
		} else {
			record('FAIL', 'session', `${res.status} ${await res.text()}`);
			await cleanup();
			return summarize();
		}
	}

	// 3. Room — bearer-only surface. GET creates-on-first-touch and reads the doc.
	if (bearer) {
		const roomId = `smoke-${randHex(4)}`;
		const url = `${BASE_URL}/api/owners/${encodeURIComponent(ownerId)}/rooms/${roomId}?nodeId=smoke`;
		const res = await fetch(url, { headers: authHeaders });
		const buf = await res.arrayBuffer();
		record(
			res.ok ? 'PASS' : 'FAIL',
			'room open+read',
			`${res.status} doc=${buf.byteLength}B`,
		);
	} else {
		record('SKIP', 'room open+read', 'bearer-only surface, no bearer minted');
	}

	// 4. Blob lifecycle.
	const payload = new TextEncoder().encode(
		`epicenter blob smoke ${new Date().toISOString()} ${randHex(4)}\n`,
	);
	const sha256 = await sha256Hex(payload);
	const owner = ownerId as never;
	const ticketRes = await fetch(API_ROUTES.blobs.list.url(BASE_URL, owner), {
		method: 'POST',
		headers: { ...authHeaders, 'content-type': 'application/json' },
		body: JSON.stringify({
			sha256,
			sizeBytes: payload.byteLength,
			contentType: 'text/plain',
		}),
	});

	if (ticketRes.status === 503) {
		record(
			'SKIP',
			'blob ticket',
			'503 StorageNotConfigured (no BLOBS_S3_* on this server) — expected without S3',
		);
	} else if (!ticketRes.ok) {
		record(
			'FAIL',
			'blob ticket',
			`${ticketRes.status} ${await ticketRes.text()}`,
		);
	} else {
		const ticket = (await ticketRes.json()) as {
			status: 'upload' | 'duplicate';
			uploadUrl?: string;
			requiredHeaders?: Record<string, string>;
		};
		record(
			'PASS',
			'blob ticket',
			`${ticketRes.status} status=${ticket.status}`,
		);

		if (ticket.status === 'upload' && ticket.uploadUrl) {
			const putRes = await fetch(ticket.uploadUrl, {
				method: 'PUT',
				headers: ticket.requiredHeaders,
				body: payload,
			});
			record(
				putRes.ok ? 'PASS' : 'FAIL',
				'blob PUT (presigned)',
				`${putRes.status}`,
			);
		} else {
			record(
				'PASS',
				'blob PUT (presigned)',
				'skipped (duplicate, already stored)',
			);
		}

		// Read back: 302 -> presigned GET -> compare bytes.
		const readRes = await fetch(
			API_ROUTES.blobs.byHash.url(BASE_URL, owner, sha256),
			{ headers: authHeaders, redirect: 'manual' },
		);
		const presigned = readRes.headers.get('location');
		if (readRes.status === 302 && presigned) {
			const objRes = await fetch(presigned);
			const got = new Uint8Array(await objRes.arrayBuffer());
			const match =
				got.byteLength === payload.byteLength &&
				(await sha256Hex(got)) === sha256;
			record(
				match ? 'PASS' : 'FAIL',
				'blob read back',
				`302 -> ${objRes.status}, bytes ${match ? 'match' : 'MISMATCH'}`,
			);
		} else {
			record('FAIL', 'blob read back', `expected 302, got ${readRes.status}`);
		}

		// Usage.
		const usageRes = await fetch(API_ROUTES.blobs.usage.url(BASE_URL, owner), {
			headers: authHeaders,
		});
		if (usageRes.ok) {
			const { totalBytes } = (await usageRes.json()) as { totalBytes: number };
			record(
				'PASS',
				'blob usage',
				`${usageRes.status} totalBytes=${totalBytes}`,
			);
		} else {
			record('FAIL', 'blob usage', `${usageRes.status}`);
		}

		// Cleanup the uploaded object (idempotent).
		await fetch(API_ROUTES.blobs.byHash.url(BASE_URL, owner, sha256), {
			method: 'DELETE',
			headers: authHeaders,
		});
	}

	await cleanup();
	return summarize();
}

function summarize() {
	const counts = rows.reduce(
		(acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
		{} as Record<Status, number>,
	);
	console.log(
		`\nSummary: ${counts.PASS ?? 0} pass, ${counts.FAIL ?? 0} fail, ${counts.SKIP ?? 0} skip\n`,
	);
	process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
}

await main();
