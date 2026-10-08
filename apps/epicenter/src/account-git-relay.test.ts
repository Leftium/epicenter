/**
 * Native Git relays: one capability path per transfer, forwarding exactly one
 * service of one paired revision through the real boot Account, retired by
 * Rust or by the Account's disposal. Everything here runs in process; the
 * loopback round trip with real Git belongs to the native acceptance run.
 */
import { expect, test } from 'bun:test';
import { epicenterCloud } from '@epicenter/auth';
import type { AccountIdentity } from '@epicenter/principal';
import {
	createAccountGitRelay,
	GIT_RELAY_ROUTE,
	type GitService,
	NATIVE_GIT_ROUTE,
} from './account-git-relay.ts';
import { createDesktopAuthAuthority } from './desktop-auth-authority.ts';
import { createHomeHost } from './host.ts';
import { createHomeServer } from './server.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { loadStaticAssets } from './static-assets.ts';
import { COMPILED_APPLICATIONS } from './applications.ts';

const API = 'https://api.epicenter.so';
const ORIGIN = 'http://127.0.0.1:49152';
const HOST = new URL(ORIGIN).host;
const ALICE = {
	authorityId: 'epicenter-api',
	principalId: 'alice',
} as AccountIdentity;
const REVISION = 'AAAAAAAAAAAAAAAAAAAAAA';
const FOLDER = 'com.bradenwong.zhongwen';
const CONNECTOR = `${API}/api/git/github`;

type Sent = {
	url: string;
	method: string;
	headers: Record<string, string>;
	init: RequestInit | undefined;
	body?: string;
	signal: AbortSignal | null;
};

/**
 * A signed-in desktop authority whose underlying fetch is `upstream`. Its
 * Account is the real one: it verifies the session, adds the bearer, and
 * wraps a streamed body in a Request exactly as production does.
 */
function signedIn(upstream: (sent: Sent) => Response | Promise<Response>) {
	const sent: Sent[] = [];
	const auth = createDesktopAuthAuthority({
		server: epicenterCloud(API),
		accountManagement: true,
		authCell: JSON.stringify({
			origin: API,
			auth: { token: 'alice-token', principalId: 'alice' },
		}),
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth() {},
			async openAuthUrl() {},
			async prepareRelaunch() {
				return { relaunch() {}, abort() {} };
			},
			onAuthCallback() {
				return () => false;
			},
		},
		async fetch(input, init) {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			if (new URL(url).pathname === '/api/session')
				return Response.json({ principalId: 'alice' });
			const headers: Record<string, string> = {};
			new Headers(init?.headers ?? request?.headers).forEach((value, key) => {
				headers[key] = value;
			});
			const bodySource = request ? request.body : init?.body;
			const record: Sent = {
				url,
				method: request?.method ?? init?.method ?? 'GET',
				headers,
				init,
				signal: init?.signal ?? request?.signal ?? null,
				...(bodySource
					? { body: await new Response(bodySource as BodyInit).text() }
					: {}),
			};
			sent.push(record);
			return upstream(record);
		},
	});
	const relay = createAccountGitRelay({
		account: auth.account,
		origin: ORIGIN,
		signal: auth.signal,
	});
	return { auth, relay, sent };
}

function relayRequest(
	url: string,
	init: RequestInit & { headers?: Record<string, string> } = {},
) {
	return new Request(url, { ...init, headers: { host: HOST, ...init.headers } });
}

function split(url: string) {
	const path = new URL(url).pathname;
	const [token] = path.slice(GIT_RELAY_ROUTE.length + 1).split('/');
	return { token: token!, rest: path.slice(GIT_RELAY_ROUTE.length + 1 + token!.length) };
}

function start(
	relay: ReturnType<typeof signedIn>['relay'],
	service: GitService = 'git-upload-pack',
) {
	const started = relay.start({ account: ALICE, folderId: FOLDER, revision: REVISION, service });
	if ('error' in started) throw new Error(started.message);
	return started;
}

test('a relay is one capability path of the host origin, with no launch token in it', () => {
	const { auth, relay } = signedIn(() => new Response('unused'));
	const started = start(relay);
	expect(started.url).toMatch(
		new RegExp(`^${ORIGIN}${GIT_RELAY_ROUTE}/[0-9a-f]{64}/repo\\.git$`),
	);
	expect(started.id).toMatch(/^[0-9a-f]{32}$/);
	expect(relay.size).toBe(1);
	auth[Symbol.dispose]();
});

test('starting refuses signed out, another account, a malformed request, and a disposed Account', () => {
	using signedOut = createDesktopAuthAuthority({
		server: epicenterCloud(API),
		authCell: null,
		accountManagement: true,
		nativeAuthPort: {
			completed: new Promise(() => undefined),
			async storeAuth() {},
			async openAuthUrl() {},
			async prepareRelaunch() {
				return { relaunch() {}, abort() {} };
			},
			onAuthCallback() {
				return () => false;
			},
		},
	});
	const nobody = createAccountGitRelay({
		account: signedOut.account,
		origin: ORIGIN,
		signal: signedOut.signal,
	});
	const request = {
		account: ALICE,
		folderId: FOLDER,
		revision: REVISION,
		service: 'git-upload-pack' as const,
	};
	expect(nobody.start(request)).toMatchObject({ error: 'signed-out' });

	const { auth, relay } = signedIn(() => new Response('unused'));
	expect(
		relay.start({ ...request, account: { ...ALICE, principalId: 'mallory' } as AccountIdentity }),
	).toMatchObject({ error: 'account-mismatch' });
	expect(
		relay.start({ ...request, account: { ...ALICE, authorityId: 'other' } as AccountIdentity }),
	).toMatchObject({ error: 'account-mismatch' });
	for (const invalid of [
		{ folderId: '../escape' },
		{ folderId: '.hidden' },
		{ revision: 'short' },
		{ revision: `${REVISION}/x` },
		{ service: 'git-upload-archive' },
	])
		expect(relay.start({ ...request, ...invalid } as typeof request)).toMatchObject({
			error: 'invalid-request',
		});
	expect(relay.size).toBe(0);
	auth[Symbol.dispose]();
	expect(relay.start(request)).toMatchObject({ error: 'retired' });
});

test('discovery forwards exactly one service of one revision through the real Account, without keepalive', async () => {
	const { auth, relay, sent } = signedIn(
		() =>
			new Response('# service=git-upload-pack\n', {
				headers: {
					'content-type': 'application/x-git-upload-pack-advertisement',
					'set-cookie': 'upstream=1',
					'www-authenticate': 'Basic realm="nope"',
				},
			}),
	);
	const started = start(relay);
	const { token, rest } = split(`${started.url}/info/refs`);
	const response = await relay.handle(
		relayRequest(`${started.url}/info/refs?service=git-upload-pack`, {
			headers: {
				'git-protocol': 'version=2',
				accept: '*/*',
				'user-agent': 'git/2.50.1',
				authorization: 'Basic aG9zdGlsZQ==',
				cookie: 'leak=1',
			},
		}),
		token,
		rest,
	);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('# service=git-upload-pack\n');
	expect(response.headers.get('content-type')).toBe(
		'application/x-git-upload-pack-advertisement',
	);
	expect(response.headers.get('set-cookie')).toBeNull();
	expect(response.headers.get('www-authenticate')).toBeNull();
	expect(sent).toHaveLength(1);
	const [upstream] = sent;
	expect(upstream!.url).toBe(
		`${CONNECTOR}/git/${FOLDER}/${REVISION}/info/refs?service=git-upload-pack`,
	);
	// Only the Account's own bearer; nothing Git sent about credentials.
	expect(upstream!.headers).toEqual({
		accept: '*/*',
		'git-protocol': 'version=2',
		authorization: 'Bearer alice-token',
	});
	expect(upstream!.init).toMatchObject({
		keepalive: false,
		redirect: 'manual',
		credentials: 'omit',
	});
	auth[Symbol.dispose]();
});

test('a streamed RPC body keeps keepalive: false through the Account and reaches the connector whole', async () => {
	const { auth, relay, sent } = signedIn(
		() =>
			new Response('pack', {
				headers: { 'content-type': 'application/x-git-receive-pack-result' },
			}),
	);
	const started = start(relay, 'git-receive-pack');
	const { token, rest } = split(`${started.url}/git-receive-pack`);
	const body = new Blob(['0000PACK-bytes']).stream();
	const response = await relay.handle(
		relayRequest(`${started.url}/git-receive-pack`, {
			method: 'POST',
			body,
			duplex: 'half',
			headers: {
				'content-type': 'application/x-git-receive-pack-request',
				'content-encoding': 'gzip',
			},
		} as RequestInit & { headers: Record<string, string> }),
		token,
		rest,
	);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('pack');
	expect(sent).toHaveLength(1);
	expect(sent[0]!.url).toBe(`${CONNECTOR}/git/${FOLDER}/${REVISION}/git-receive-pack`);
	expect(sent[0]!.body).toBe('0000PACK-bytes');
	// The Account wrapped the stream in a Request; the option still reached fetch.
	expect(sent[0]!.init?.keepalive).toBe(false);
	expect(sent[0]!.headers['content-encoding']).toBe('gzip');
	auth[Symbol.dispose]();
});

test('only the relay service, method, path, and content type are forwarded', async () => {
	const { auth, relay, sent } = signedIn(() => new Response('unexpected'));
	const started = start(relay);
	const ask = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => {
		const { token, rest } = split(`${started.url}${path.split('?')[0]}`);
		return relay.handle(relayRequest(`${started.url}${path}`, init), token, rest);
	};
	expect((await ask('/info/refs?service=git-receive-pack')).status).toBe(403);
	expect((await ask('/info/refs')).status).toBe(403);
	expect((await ask('/info/refs?service=git-upload-pack&x=1')).status).toBe(403);
	expect((await ask('/info/refs?service=git-upload-pack', { method: 'POST' })).status).toBe(405);
	expect((await ask('/git-receive-pack', { method: 'POST' })).status).toBe(403);
	expect((await ask('/git-upload-pack')).status).toBe(405);
	expect(
		(
			await ask('/git-upload-pack', {
				method: 'POST',
				body: 'x',
				headers: { 'content-type': 'text/plain' },
			})
		).status,
	).toBe(415);
	expect((await ask('/HEAD')).status).toBe(404);
	expect((await ask('/../../api/session')).status).toBe(404);
	// A page names itself with an Origin; Git never does.
	expect(
		(
			await ask('/info/refs?service=git-upload-pack', {
				headers: { origin: ORIGIN },
			})
		).status,
	).toBe(403);
	expect(
		(await relay.handle(relayRequest(`${ORIGIN}/x`), 'f'.repeat(64), '/repo.git/info/refs')).status,
	).toBe(404);
	expect(sent).toHaveLength(0);
	auth[Symbol.dispose]();
});

test('redirects, session refusals, and connector refusals reach Git as a plain 502, once, and are kept for retirement', async () => {
	for (const [answer, failure] of [
		[
			new Response(null, { status: 307, headers: { location: 'https://evil.test/' } }),
			{ reason: 'redirect', status: 307 },
		],
		[
			new Response('no', {
				status: 401,
				headers: { 'www-authenticate': 'Basic realm="x"' },
			}),
			{ reason: 'session', status: 401 },
		],
		[
			Response.json(
				{ error: 'scoped_token_rejected' },
				{ status: 403, headers: { 'x-epicenter-git-error': 'scoped_token_rejected' } },
			),
			{ reason: 'connector', status: 403, code: 'scoped_token_rejected' },
		],
		[
			Response.json(
				{ error: 'pairing_superseded' },
				{ status: 409, headers: { 'x-epicenter-git-error': 'pairing_superseded' } },
			),
			{ reason: 'connector', status: 409, code: 'pairing_superseded' },
		],
		[new Response('gateway', { status: 504 }), { reason: 'http', status: 504 }],
	] as const) {
		const { auth, relay, sent } = signedIn(() => answer.clone());
		const started = start(relay);
		const { token, rest } = split(`${started.url}/info/refs`);
		const response = await relay.handle(
			relayRequest(`${started.url}/info/refs?service=git-upload-pack`),
			token,
			rest,
		);
		expect(response.status).toBe(502);
		expect(response.headers.get('location')).toBeNull();
		expect(response.headers.get('www-authenticate')).toBeNull();
		// No retry here; a post-admission 403 is final for this request. The
		// Account's own replay needs a replaced credential, which this is not.
		expect(sent.filter((request) => request.url.includes('/git/'))).toHaveLength(1);
		expect(relay.retire(started.id)).toEqual({ retired: true, failure });
		auth[Symbol.dispose]();
	}
});

test('retiring aborts the in-flight upstream request and closes the path; retiring again reports nothing alive', async () => {
	const entered = Promise.withResolvers<AbortSignal>();
	const { auth, relay } = signedIn(
		(sent) =>
			new Promise<Response>((_, reject) => {
				entered.resolve(sent.signal!);
				sent.signal!.addEventListener('abort', () => reject(sent.signal!.reason));
			}),
	);
	const started = start(relay);
	const { token, rest } = split(`${started.url}/info/refs`);
	const pending = relay.handle(
		relayRequest(`${started.url}/info/refs?service=git-upload-pack`),
		token,
		rest,
	);
	const upstreamSignal = await entered.promise;
	expect(upstreamSignal.aborted).toBe(false);
	expect(relay.retire(started.id)).toEqual({ retired: true });
	expect(upstreamSignal.aborted).toBe(true);
	expect((await pending).status).toBe(502);
	expect(
		(
			await relay.handle(
				relayRequest(`${started.url}/info/refs?service=git-upload-pack`),
				token,
				rest,
			)
		).status,
	).toBe(404);
	expect(relay.retire(started.id)).toEqual({ retired: false });
	expect(relay.size).toBe(0);
	auth[Symbol.dispose]();
});

test('disposing the Account retires every relay at once, mid-response', async () => {
	const { auth, relay } = signedIn(
		(sent) =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('first'));
						sent.signal!.addEventListener('abort', () =>
							controller.error(sent.signal!.reason),
						);
					},
				}),
				{ headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } },
			),
	);
	const one = start(relay);
	const two = start(relay, 'git-receive-pack');
	const { token, rest } = split(`${one.url}/info/refs`);
	const response = await relay.handle(
		relayRequest(`${one.url}/info/refs?service=git-upload-pack`),
		token,
		rest,
	);
	const reader = response.body!.getReader();
	expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
	auth[Symbol.dispose]();
	expect(auth.signal.aborted).toBe(true);
	await expect(reader.read()).rejects.toBeDefined();
	expect(relay.size).toBe(0);
	expect(relay.retire(one.id)).toEqual({ retired: false });
	expect(relay.retire(two.id)).toEqual({ retired: false });
});

test('pairing discovery reads one folder through the boot Account and refuses what it cannot use', async () => {
	const pairing = {
		folderId: FOLDER,
		revision: REVISION,
		status: 'ready',
		repository: { id: 9001, installationId: 7001, fullName: 'alice/zhongwen' },
		remote: { url: 'https://github.com/alice/zhongwen.git', branch: 'main' },
	};
	let answer: Response = Response.json({ pairings: [pairing] });
	const { auth, relay, sent } = signedIn(() => answer.clone());
	expect(await relay.pairing(ALICE, FOLDER)).toEqual({
		pairing: {
			account: { authorityId: 'epicenter-api', principalId: 'alice' } as AccountIdentity,
			folderId: FOLDER,
			revision: REVISION,
			repository: pairing.repository,
			remote: pairing.remote,
		},
	});
	expect(sent[0]!.url).toBe(`${CONNECTOR}/pairings`);
	expect(sent[0]!.init).toMatchObject({ method: 'GET', keepalive: false });
	expect(sent[0]!.headers.authorization).toBe('Bearer alice-token');

	const cases: [Response, object][] = [
		[Response.json({ pairings: [] }), { error: 'pairing-not-found', status: 404 }],
		[
			Response.json({ pairings: [{ ...pairing, status: 'github_authorization_required' }] }),
			{ error: 'not-ready', code: 'github_authorization_required' },
		],
		[
			Response.json({
				pairings: [{ ...pairing, remote: { ...pairing.remote, url: 'https://evil.test/a/b.git' } }],
			}),
			{ error: 'invalid-pairing' },
		],
		[
			Response.json({ pairings: [{ ...pairing, revision: 'not-a-revision' }] }),
			{ error: 'invalid-pairing' },
		],
		[
			Response.json(
				{ error: 'github_authorization_required' },
				{ status: 403, headers: { 'x-epicenter-git-error': 'github_authorization_required' } },
			),
			{ error: 'not-ready', code: 'github_authorization_required' },
		],
		[
			Response.json(
				{ error: 'upstream_unavailable' },
				{ status: 503, headers: { 'x-epicenter-git-error': 'upstream_unavailable' } },
			),
			{ error: 'connector', code: 'upstream_unavailable' },
		],
		[new Response(null, { status: 302, headers: { location: '/' } }), { error: 'unavailable' }],
		[new Response('not json'), { error: 'invalid-pairing' }],
		// The Epicenter session itself, last: the Account pauses after it.
		[new Response(null, { status: 401 }), { error: 'session', status: 401 }],
		[Response.json({ pairings: [pairing] }), { error: 'session', status: 401 }],
	];
	for (const [response, expected] of cases) {
		answer = response;
		const result = await relay.pairing(ALICE, FOLDER);
		expect(result).toMatchObject(expected);
		// A person is told something plain, never who the principal is.
		expect('message' in result && result.message).not.toContain('alice');
	}
	expect(await relay.pairing({ ...ALICE, principalId: 'bob' } as AccountIdentity, FOLDER)).toMatchObject({
		error: 'account-mismatch',
	});
	expect(await relay.pairing(ALICE, '../x')).toMatchObject({ error: 'invalid-request' });
	auth[Symbol.dispose]();
});

test('the host serves native controls only to the launch token without an Origin or cookie, and relay paths to Git', async () => {
	await using host = await createHomeHost({ model: 'test', engine: async function* () {} });
	const page = '<!doctype html><html><head></head><body></body></html>';
	const directory = writeAppsDist({ homePage: page, applicationPage: () => page });
	const staticAssets = await loadStaticAssets(directory, COMPILED_APPLICATIONS, []);
	const { auth, relay, sent } = signedIn(
		() =>
			new Response('ad', {
				headers: { 'content-type': 'application/x-git-upload-pack-advertisement' },
			}),
	);
	const { app } = createHomeServer({
		host,
		origin: ORIGIN,
		launchToken: 'launch',
		staticAssets,
		blobs: () => {
			throw new Error('unused');
		},
		desktopAuth: auth,
		gitRelay: relay,
	});
	const control = (path: string, body: unknown, headers: Record<string, string> = {}) =>
		app.request(`${ORIGIN}${NATIVE_GIT_ROUTE}${path}`, {
			method: 'POST',
			headers: {
				host: HOST,
				authorization: 'Bearer launch',
				'content-type': 'application/json',
				...headers,
			},
			body: JSON.stringify(body),
		});
	const startBody = {
		account: ALICE,
		folderId: FOLDER,
		revision: REVISION,
		service: 'git-upload-pack',
	};
	expect((await control('/relays', startBody, { authorization: 'Bearer nope' })).status).toBe(401);
	expect((await control('/relays', startBody, { authorization: '' })).status).toBe(401);
	expect((await control('/relays', startBody, { origin: ORIGIN })).status).toBe(403);
	expect((await control('/relays', startBody, { cookie: 'epicenter_session=x' })).status).toBe(403);
	expect((await control('/relays', startBody, { host: 'localhost:49152' })).status).toBe(421);
	expect((await control('/relays', { ...startBody, extra: true })).status).toBe(400);
	expect(
		(await control('/relays', { ...startBody, account: { ...ALICE, token: 'x' } })).status,
	).toBe(400);
	expect(relay.size).toBe(0);

	const started = await control('/relays', startBody);
	expect(started.status).toBe(200);
	expect(started.headers.get('cache-control')).toBe('no-store');
	const { relay: handle } = (await started.json()) as { relay: { id: string; url: string } };
	expect(handle.url.startsWith(`${ORIGIN}${GIT_RELAY_ROUTE}/`)).toBe(true);
	expect(handle.url).not.toContain('launch');

	// Git reaches the relay on the same listener with no launch token.
	const advertised = await app.request(`${handle.url}/info/refs?service=git-upload-pack`, {
		headers: { host: HOST, 'git-protocol': 'version=2' },
	});
	expect(advertised.status).toBe(200);
	expect(await advertised.text()).toBe('ad');
	expect(sent.at(-1)!.headers.authorization).toBe('Bearer alice-token');

	const retired = await control(`/relays/${handle.id}/retire`, {});
	expect(await retired.json()).toEqual({ retired: true });
	expect(
		(
			await app.request(`${handle.url}/info/refs?service=git-upload-pack`, {
				headers: { host: HOST },
			})
		).status,
	).toBe(404);
	expect(await (await control(`/relays/${handle.id}/retire`, {})).json()).toEqual({
		retired: false,
	});
	const refused = await control('/relays', { ...startBody, account: { ...ALICE, principalId: 'bob' } });
	expect(refused.status).toBe(409);
	expect(await refused.json()).toMatchObject({ error: 'account-mismatch' });
	auth[Symbol.dispose]();
});
