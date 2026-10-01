/**
 * Capture Bridge Host Tests
 *
 * The host's half of the Capture folder bridge: where it is mounted, what
 * guards it, and which directory it names. Requests go to the Hono app
 * directly, with the real Capture bridge over a real directory; no socket is
 * bound.
 *
 * Key behaviors:
 * - Capture is a compiled application: listed for Home, served below its id,
 *   and its ids are reserved
 * - The bridge needs the browser session; a call also needs the exact Origin;
 *   the launch token is not a credential for it
 * - The directory is `<folderRoot>/so.epicenter.capture`, chosen by startup; a
 *   request cannot name another
 * - The event stream is session-gated and starts with the Git snapshot
 * - Closing the bridge, as host shutdown does, refuses later calls
 *
 * See also:
 * - `apps/capture/native/bridge.test.ts` for the bridge and its folder owner
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import {
	createCaptureBridge,
	type CaptureBridge,
	captureDefinition,
} from '@epicenter/capture-app/native';
import {
	COMPILED_APPLICATIONS,
	RESERVED_APPLICATION_IDS,
	CAPTURE_APPLICATION,
} from './applications.ts';
import { createHomeHost } from './host.ts';
import {
	APPLICATIONS_ROUTE,
	BOOTSTRAP_ROUTE,
	CAPTURE_BRIDGE_ROUTE,
	CAPTURE_ROUTE,
} from './routes.ts';
import { type ApplicationsResponse, createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { createTestDesktopAuth } from './test-home-host.ts';

const ORIGIN = 'http://127.0.0.1:49152';
const HOST = new URL(ORIGIN).host;
const LAUNCH_TOKEN = 'launch';
const CALL = `${CAPTURE_BRIDGE_ROUTE.url(ORIGIN)}/call`;
const EVENTS = `${CAPTURE_BRIDGE_ROUTE.url(ORIGIN)}/events`;
const INFO = JSON.stringify({ path: ['host', 'info'], args: [] });

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const run of cleanups.splice(0).reverse()) await run();
});

function scratch(prefix: string) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

/** The host as `main.ts` composes it: the bridge rooted under `folderRoot`. */
async function serve({ withCapture = true }: { withCapture?: boolean } = {}) {
	const folderRoot = scratch('epicenter-capture-folder-');
	const host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	cleanups.push(() => host[Symbol.asyncDispose]());
	const desktopAuth = createTestDesktopAuth();
	cleanups.push(() => desktopAuth[Symbol.dispose]());
	let capture: CaptureBridge | undefined;
	if (withCapture) {
		const bridge = createCaptureBridge({
			root: join(folderRoot, captureDefinition.id),
		});
		cleanups.push(() => bridge.close());
		capture = bridge;
	}
	const blobs = scratch('epicenter-capture-blobs-');
	const { app } = createHomeServer({
		folderRoot,
		host,
		origin: ORIGIN,
		launchToken: LAUNCH_TOKEN,
		staticAssets: await loadStaticAssets(
			writeAppsDist({
				root: scratch('epicenter-capture-dist-'),
				homePage: '<!doctype html><html><body>Home</body></html>',
				applicationPage: ({ title }) =>
					`<!doctype html><html><body>${title} test application</body></html>`,
			}),
			COMPILED_APPLICATIONS,
		),
		blobs: (appId, owner) =>
			createBunBlobStore({ directory: join(blobs, appId, owner ?? 'none') }),
		desktopAuth,
		capture,
	});
	const bootstrap = await app.request(BOOTSTRAP_ROUTE.url(ORIGIN), {
		method: 'POST',
		headers: {
			host: HOST,
			origin: ORIGIN,
			authorization: `Bearer ${LAUNCH_TOKEN}`,
		},
	});
	const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
	return { app, cookie, folderRoot, capture };
}

describe('Capture as a compiled application', () => {
	test('is declared, listed for Home, and served below its id', async () => {
		const { app, cookie } = await serve();

		expect(CAPTURE_APPLICATION).toEqual({ id: 'capture', title: 'Capture' });
		expect(COMPILED_APPLICATIONS).toContainEqual(CAPTURE_APPLICATION);
		expect(CAPTURE_ROUTE.pattern).toBe('/apps/capture/');

		const listed = (await (
			await app.request(APPLICATIONS_ROUTE.url(ORIGIN), {
				headers: { host: HOST, cookie },
			})
		).json()) as ApplicationsResponse;
		expect(listed.apps).toContainEqual({ id: 'capture', title: 'Capture' });

		const page = await app.request(CAPTURE_ROUTE.url(ORIGIN), {
			headers: { host: HOST, cookie },
		});
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('Capture test application');
		// The bridge is same-origin, so the page's policy needs no wider reach.
		expect(page.headers.get('content-security-policy')).toContain(
			"connect-src 'self' ipc: http://ipc.localhost;",
		);
	});

	test('its route id and its folder id cannot be installed over', () => {
		expect(captureDefinition.id).toBe('so.epicenter.capture');
		expect(RESERVED_APPLICATION_IDS).toContain('capture');
		expect(RESERVED_APPLICATION_IDS).toContain(captureDefinition.id);
	});
});

describe('the Capture bridge gate', () => {
	test('a call needs the browser session and the exact Origin', async () => {
		const { app, cookie, folderRoot } = await serve();
		const call = (headers: Record<string, string>) =>
			app.request(CALL, {
				method: 'POST',
				headers: { host: HOST, 'content-type': 'application/json', ...headers },
				body: INFO,
			});

		expect((await call({ origin: ORIGIN })).status).toBe(401);
		// The launch token mints sessions at bootstrap and opens nothing else.
		expect(
			(await call({ origin: ORIGIN, authorization: `Bearer ${LAUNCH_TOKEN}` }))
				.status,
		).toBe(401);
		expect(
			(await call({ origin: ORIGIN, cookie: 'epicenter_session=x' })).status,
		).toBe(401);
		expect((await call({ cookie })).status).toBe(403);
		expect(
			(await call({ cookie, origin: 'http://127.0.0.1:49153' })).status,
		).toBe(403);
		expect(
			(await call({ cookie, origin: 'http://localhost:49152' })).status,
		).toBe(403);
		// Nothing above reached the folder, so nothing was created.
		expect(
			await lstat(join(folderRoot, captureDefinition.id)).catch(() => undefined),
		).toBeUndefined();

		const allowed = await call({ cookie, origin: ORIGIN });
		expect(allowed.status).toBe(200);
		expect(allowed.headers.get('cache-control')).toBe('no-store');
		expect(await allowed.json()).toEqual({
			ok: {
				root: join(folderRoot, 'so.epicenter.capture'),
			},
		});
	});

	test('a request cannot choose the directory', async () => {
		const { app, cookie, folderRoot } = await serve();
		const elsewhere = scratch('epicenter-capture-elsewhere-');
		const call = (body: unknown, url = CALL) =>
			app.request(url, {
				method: 'POST',
				headers: {
					host: HOST,
					origin: ORIGIN,
					cookie,
					'content-type': 'application/json',
				},
				body: JSON.stringify(body),
			});

		expect(
			(await call({ path: ['host', 'info'], args: [{ root: elsewhere }] }))
				.status,
		).toBe(400);
		expect(
			(await call({ path: ['host', 'open'], args: [elsewhere] })).status,
		).toBe(400);
		const queried = await call(
			{ path: ['host', 'info'], args: [], root: elsewhere },
			`${CALL}?root=${encodeURIComponent(elsewhere)}`,
		);

		expect(((await queried.json()) as { ok: { root: string } }).ok.root).toBe(
			join(folderRoot, 'so.epicenter.capture'),
		);
		expect(
			await lstat(join(elsewhere, 'captures')).catch(() => undefined),
		).toBeUndefined();
		expect(
			(
				await lstat(join(folderRoot, 'so.epicenter.capture', 'captures'))
			).isDirectory(),
		).toBe(true);
	});

	test('the event stream needs the session and starts with the Git snapshot', async () => {
		const { app, cookie } = await serve();

		expect(
			(await app.request(EVENTS, { headers: { host: HOST } })).status,
		).toBe(401);
		// A page from another origin is refused before the session is considered.
		expect(
			(
				await app.request(EVENTS, {
					headers: { host: HOST, cookie, origin: 'https://example.test' },
				})
			).status,
		).toBe(403);
		expect(
			(await app.request(EVENTS, { headers: { host: 'example.test', cookie } }))
				.status,
		).toBe(421);

		const leaving = new AbortController();
		const stream = await app.request(EVENTS, {
			headers: { host: HOST, cookie },
			signal: leaving.signal,
		});
		expect(stream.status).toBe(200);
		expect(stream.headers.get('content-type')).toBe('application/x-ndjson');
		expect(stream.headers.get('cache-control')).toBe('no-store');
		const reader = stream.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(JSON.parse(first.split('\n')[0]!)).toMatchObject({
			type: 'git',
			snapshot: { branch: 'main', commitOnEdit: true, remote: { $t: 'u' } },
		});
		leaving.abort();
		await reader.cancel().catch(() => {});
	});

	test('a host without the bridge answers 404 behind the same gate', async () => {
		const { app, cookie } = await serve({ withCapture: false });

		expect(
			(
				await app.request(CALL, {
					method: 'POST',
					headers: { host: HOST, origin: ORIGIN },
					body: INFO,
				})
			).status,
		).toBe(401);
		expect(
			(
				await app.request(CALL, {
					method: 'POST',
					headers: { host: HOST, origin: ORIGIN, cookie },
					body: INFO,
				})
			).status,
		).toBe(404);
	});

	test('closing the bridge, as host shutdown does, refuses later calls', async () => {
		const { app, cookie, capture } = await serve();
		const call = () =>
			app.request(CALL, {
				method: 'POST',
				headers: { host: HOST, origin: ORIGIN, cookie },
				body: INFO,
			});
		expect((await call()).status).toBe(200);

		await capture!.close();

		const refused = await call();
		expect(refused.status).toBe(503);
		expect(await refused.json()).toEqual({
			fault: 'The Capture folder is closed.',
		});
	});
});
