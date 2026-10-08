/**
 * The relay over real sockets with real Git: the host's own listener and its
 * native control routes, the real boot Account, and a stand-in hosted
 * connector that serves the connector's Git routes with `git http-backend`
 * and refuses any revision but the paired one, as the connector does.
 *
 * These need loopback listeners. Where they are refused (as in the worker
 * sandbox), every test here fails at `Bun.serve`; the in-process checks are
 * in `account-git-relay.test.ts`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterCloud } from '@epicenter/auth';
import { COMPILED_APPLICATIONS } from './applications.ts';
import {
	type AccountGitRelay,
	createAccountGitRelay,
	NATIVE_GIT_ROUTE,
} from './account-git-relay.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
import { createHomeHost, type HomeHost } from './host.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';

const FOLDER = 'com.bradenwong.zhongwen';
const REVISION = 'AAAAAAAAAAAAAAAAAAAAAA';
const REPLACED = 'BBBBBBBBBBBBBBBBBBBBBB';
const CANONICAL = 'https://github.com/alice/zhongwen.git';
const LAUNCH = 'launch-token-for-this-generation';
const ALICE = { authorityId: 'epicenter-api', principalId: 'alice' };

type Seen = { method: string; path: string; authorization: string | null; headers: string[] };

let scratch: string;
let connector: ReturnType<typeof Bun.serve>;
let home: ReturnType<typeof Bun.serve>;
let host: HomeHost;
let auth: DesktopAuthAuthority;
let relay: AccountGitRelay;
let origin: string;
const seen: Seen[] = [];

/** Fixture Git client: relay calls use HTTP only; local setup alone permits file transport. */
async function git(cwd: string, args: string[], localSetup = false) {
	const child = Bun.spawn(['git', '-c', 'http.proxy=', ...args], {
		cwd,
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: scratch,
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_ALLOW_PROTOCOL: localSetup ? 'http:file' : 'http',
			GIT_TERMINAL_PROMPT: '0',
			NO_PROXY: '*',
			GIT_AUTHOR_NAME: 'Alice',
			GIT_AUTHOR_EMAIL: 'alice@example.com',
			GIT_COMMITTER_NAME: 'Alice',
			GIT_COMMITTER_EMAIL: 'alice@example.com',
		},
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** The connector's Git routes over `git http-backend`, for the paired revision only. */
async function serveGit(request: Request, rest: string, search: string) {
	const body = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined;
	const child = Bun.spawn(['git', 'http-backend'], {
		env: {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			GIT_CONFIG_GLOBAL: '/dev/null',
			GIT_CONFIG_NOSYSTEM: '1',
			GIT_PROJECT_ROOT: join(scratch, 'github'),
			GIT_HTTP_EXPORT_ALL: '1',
			PATH_INFO: `/repo.git/${rest}`,
			REQUEST_METHOD: request.method,
			QUERY_STRING: search.replace(/^\?/, ''),
			CONTENT_TYPE: request.headers.get('content-type') ?? '',
			CONTENT_LENGTH: String(body?.byteLength ?? 0),
			HTTP_CONTENT_ENCODING: request.headers.get('content-encoding') ?? '',
			GIT_PROTOCOL: request.headers.get('git-protocol') ?? '',
			REMOTE_USER: 'alice',
			REMOTE_ADDR: '127.0.0.1',
			SERVER_PROTOCOL: 'HTTP/1.1',
		},
		stdin: body ?? 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [out, code] = await Promise.all([new Response(child.stdout).arrayBuffer(), child.exited]);
	if (code !== 0) return new Response('backend failed', { status: 500 });
	const bytes = Buffer.from(out);
	const split = bytes.indexOf('\r\n\r\n');
	const headers = new Headers();
	let status = 200;
	for (const line of bytes.subarray(0, split).toString().split('\r\n')) {
		const colon = line.indexOf(':');
		const name = line.slice(0, colon);
		const value = line.slice(colon + 1).trim();
		if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
		else headers.append(name, value);
	}
	return new Response(bytes.subarray(split + 4), { status, headers });
}

function refuse(code: string, status: number) {
	return Response.json({ error: code }, { status, headers: { 'x-epicenter-git-error': code } });
}

beforeAll(async () => {
	scratch = mkdtempSync(join(tmpdir(), 'epicenter-relay-loopback-'));
	const bare = join(scratch, 'github', 'repo.git');
	mkdirSync(bare, { recursive: true });
	await git(bare, ['init', '--quiet', '--bare', '--initial-branch=main']);
	const author = join(scratch, 'author');
	mkdirSync(author);
	await git(author, ['init', '--quiet', '--initial-branch=main']);
	await Bun.write(join(author, 'deck.md'), '你好');
	await git(author, ['add', 'deck.md']);
	await git(author, ['commit', '--quiet', '-m', 'from the browser']);
	expect(await git(author, ['push', '--quiet', bare, 'main'], true)).toMatchObject({ code: 0 });

	connector = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			seen.push({
				method: request.method,
				path: `${url.pathname}${url.search}`,
				authorization: request.headers.get('authorization'),
				headers: [...request.headers.keys()],
			});
			if (request.headers.get('authorization') !== 'Bearer alice-token')
				return new Response(null, { status: 401 });
			if (url.pathname === '/api/session') return Response.json({ principalId: 'alice' });
			if (url.pathname === '/api/git/github/pairings')
				return Response.json({
					pairings: [
						{
							folderId: FOLDER,
							revision: REVISION,
							status: 'ready',
							repository: { id: 9001, installationId: 7001, fullName: 'alice/zhongwen' },
							remote: { url: CANONICAL, branch: 'main' },
						},
					],
				});
			const git = /^\/api\/git\/github\/git\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(
				url.pathname,
			);
			if (!git) return refuse('invalid_request', 404);
			if (git[1] !== FOLDER) return refuse('pairing_not_found', 404);
			if (git[2] !== REVISION) return refuse('pairing_superseded', 409);
			return serveGit(request, git[3]!, url.search);
		},
	});
	const api = `http://127.0.0.1:${connector.port}`;
	auth = createDesktopAuthAuthority({
		server: epicenterCloud(api),
		accountManagement: true,
		authCell: JSON.stringify({ origin: api, auth: { token: 'alice-token', principalId: 'alice' } }),
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
	// Reserve a port before composing the exact Host guard.
	const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
	const port = probe.port;
	await probe.stop(true);
	origin = `http://127.0.0.1:${port}`;
	relay = createAccountGitRelay({ account: auth.account, origin, signal: auth.signal });
	host = await createHomeHost({ model: 'test', engine: async function* () {} });
	const page = '<!doctype html><html><head></head><body></body></html>';
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: LAUNCH,
		staticAssets: await loadStaticAssets(
			writeAppsDist({ homePage: page, applicationPage: () => page }),
			COMPILED_APPLICATIONS,
			[],
		),
		blobs: () => {
			throw new Error('unused');
		},
		desktopAuth: auth,
		gitRelay: relay,
	});
	home = Bun.serve({ hostname: '127.0.0.1', port, fetch: app.fetch, websocket });
});

afterAll(async () => {
	auth?.[Symbol.dispose]();
	await home?.stop(true);
	await connector?.stop(true);
	await host?.[Symbol.asyncDispose]();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** A native control call, as Rust sends it: the launch token, no Origin, no cookie. */
function control(path: string, body: unknown, headers: Record<string, string> = {}) {
	return fetch(`${origin}${NATIVE_GIT_ROUTE}${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${LAUNCH}`, 'content-type': 'application/json', ...headers },
		body: JSON.stringify(body),
	});
}

async function start(service: string, revision = REVISION) {
	const response = await control('/relays', { account: ALICE, folderId: FOLDER, revision, service });
	expect(response.status).toBe(200);
	return ((await response.json()) as { relay: { id: string; url: string } }).relay;
}

test('native controls on the real listener admit only the launch token, without an Origin or cookie', async () => {
	const body = { account: ALICE, folderId: FOLDER, revision: REVISION, service: 'git-upload-pack' };
	expect((await control('/relays', body, { authorization: 'Bearer wrong' })).status).toBe(401);
	expect((await control('/relays', body, { origin })).status).toBe(403);
	expect((await control('/relays', body, { cookie: 'epicenter_session=x' })).status).toBe(403);
	expect(relay.size).toBe(0);
	// The pairing read is the source of the immutable repository ID a download records.
	const paired = await control('/pairing', { account: ALICE, folderId: FOLDER });
	expect(await paired.json()).toMatchObject({
		pairing: { revision: REVISION, repository: { id: 9001 }, remote: { url: CANONICAL, branch: 'main' } },
	});
});

test('real Git downloads through one upload-pack relay; the launch token never goes upstream', async () => {
	seen.length = 0;
	const handle = await start('git-upload-pack');
	expect(handle.url).not.toContain(LAUNCH);
	const clone = join(scratch, `download-${Date.now()}`);
	mkdirSync(clone);
	await git(clone, ['init', '--quiet', '--initial-branch=main']);
	const fetched = await git(clone, [
		'fetch',
		'--no-tags',
		'--quiet',
		handle.url,
		'+refs/heads/main:refs/remotes/origin/main',
	]);
	expect(fetched).toMatchObject({ code: 0 });
	expect((await git(clone, ['log', '-1', '--format=%s', 'refs/remotes/origin/main'])).stdout.trim()).toBe(
		'from the browser',
	);
	const gitRequests = seen.filter((request) => request.path.includes('/api/git/github/git/'));
	expect(gitRequests.length).toBeGreaterThan(0);
	for (const request of gitRequests) {
		expect(request.path).toContain(`/git/${FOLDER}/${REVISION}/`);
		expect(request.path).not.toContain('receive-pack');
		expect(request.authorization).toBe('Bearer alice-token');
	}
	for (const request of seen) expect(JSON.stringify(request)).not.toContain(LAUNCH);

	expect(await (await control(`/relays/${handle.id}/retire`, {})).json()).toEqual({ retired: true });
	const after = await git(clone, ['ls-remote', handle.url]);
	expect(after.code).not.toBe(0);
});

test('an upload-pack relay cannot push, and a receive-pack relay pushes exactly what Git sends', async () => {
	const work = join(scratch, `push-${Date.now()}`);
	mkdirSync(work);
	await git(work, ['init', '--quiet', '--initial-branch=main']);
	const upload = await start('git-upload-pack');
	await git(work, ['fetch', '--quiet', upload.url, '+refs/heads/main:refs/remotes/origin/main']);
	await git(work, ['reset', '--quiet', '--hard', 'refs/remotes/origin/main']);
	await Bun.write(join(work, 'native.md'), 'edited in the installed app');
	await git(work, ['add', 'native.md']);
	await git(work, ['commit', '--quiet', '-m', 'from the installed app']);

	seen.length = 0;
	const refused = await git(work, ['push', '--porcelain', upload.url, 'main:refs/heads/main']);
	expect(refused.code).not.toBe(0);
	expect(seen.some((request) => request.path.includes('receive-pack'))).toBe(false);
	await control(`/relays/${upload.id}/retire`, {});

	const receive = await start('git-receive-pack');
	const pushed = await git(work, ['push', '--porcelain', receive.url, 'main:refs/heads/main']);
	expect(pushed.code).toBe(0);
	expect(await (await control(`/relays/${receive.id}/retire`, {})).json()).toEqual({ retired: true });
	const head = await git(join(scratch, 'github', 'repo.git'), ['log', '-1', '--format=%s', 'main']);
	expect(head.stdout.trim()).toBe('from the installed app');
});

test('a replaced revision reaches nothing, and retiring reports the connector code', async () => {
	const handle = await start('git-upload-pack', REPLACED);
	const listing = await git(scratch, ['ls-remote', handle.url]);
	expect(listing.code).not.toBe(0);
	expect(`${listing.stdout}${listing.stderr}`).not.toMatch(/username|password/i);
	expect(await (await control(`/relays/${handle.id}/retire`, {})).json()).toEqual({
		retired: true,
		failure: { reason: 'connector', status: 409, code: 'pairing_superseded' },
	});
});
