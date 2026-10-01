/**
 * The Honeycrisp folder host: one real directory, opened once, served to one
 * page.
 *
 * `createFolderHost` opens the notes directory with `openNativeFolder` and
 * returns a `fetch` handler for the built page and `/bridge`. The handler is
 * a plain function, so tests drive it without a socket and `main.ts` hands
 * it to `Bun.serve`.
 *
 * The files in the directory are the saved data. Git history is ordinary Git
 * in `<root>/.git`. A successful content save through tables or files
 * requests a commit and returns without waiting for it; a commit that fails
 * is reported in the Git snapshot and never becomes a save error.
 */
import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import {
	type CommitOutcome,
	type GitSnapshot,
	pathProblem,
} from '@epicenter/app/files';
import { openNativeFolder } from '@epicenter/app/files/native';
import { decode, encode } from '../src/lib/bridge/codec.js';
import {
	type AppRequest,
	type BridgeEvent,
	type CallRequest,
	type Faults,
	type FileRevision,
	type HostInfo,
	isAllowedCall,
} from '../src/lib/bridge/contract.js';
import { honeycrispDefinition } from '../src/lib/data.js';
import { createFaults } from './faults.js';
import { runTerminalCommand } from './terminal.js';
import { createWatcher } from './watch.js';

export type FolderHostOptions = {
	/** The notes directory. Created with its table directories when absent. */
	readonly root: string;
	/** The per-launch secret every `/bridge` request must carry. */
	readonly token: string;
	/** The built page to serve; absent when only the bridge is served. */
	readonly uiDist?: string;
	/** Fault injection, for a disposable root only. Absent means unavailable. */
	readonly faults?: Partial<Faults>;
	/**
	 * Put the token in the served page. Only for running the host without a
	 * desktop shell: any local process that can fetch the page can read it.
	 */
	readonly pageToken?: boolean;
	/** Messages for the desktop shell; absent when no shell is attached. */
	readonly toShell?: (message: Record<string, unknown>) => void;
	readonly watchIntervalMs?: number;
};

const CONTENT_WRITES = new Set([
	'create',
	'update',
	'writeSource',
	'rename',
	'delete',
	'write',
	'remove',
	'move',
]);

const TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.map': 'application/json',
};

function git(root: string, args: readonly string[]) {
	return new Promise<{ code: number; stdout: string; stderr: string }>(
		(resolve) => {
			const child = spawn('git', [...args], {
				cwd: root,
				env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => (stdout += chunk));
			child.stderr.on('data', (chunk) => (stderr += chunk));
			child.on('error', (cause) =>
				resolve({ code: 127, stdout, stderr: cause.message }),
			);
			child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
		},
	);
}

/** Create the directory and its layout. Existing files are never rewritten. */
async function prepareRoot(root: string) {
	await mkdir(join(root, 'notes'), { recursive: true });
	await mkdir(join(root, 'folders'), { recursive: true });
	await writeFile(join(root, 'kv.json'), '{}\n', { flag: 'wx' }).catch(
		(cause: { code?: string }) => {
			if (cause.code !== 'EEXIST') throw cause;
		},
	);
}

export async function createFolderHost(options: FolderHostOptions) {
	const { token, uiDist } = options;
	await prepareRoot(options.root);
	const name = (await git(options.root, ['config', 'user.name'])).stdout.trim();
	const email = (
		await git(options.root, ['config', 'user.email'])
	).stdout.trim();
	// The host requests commits itself, after each content save, so a commit
	// can be made to fail on purpose without touching the save.
	const folder = await openNativeFolder({
		root: options.root,
		definition: honeycrispDefinition,
		git: {
			author: {
				name: name || 'Honeycrisp',
				email: email || 'honeycrisp@localhost',
			},
			commitOnEdit: false,
		},
	});
	// `openNativeFolder` resolves links; commands and the page see the same path.
	const root = await realpath(options.root);
	const faults = createFaults(options.faults !== undefined, options.faults);

	/** Set after the socket is bound; requests for any other host are refused. */
	let origin: string | undefined;
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const encoder = new TextEncoder();
	let closePending = false;

	function broadcast(event: BridgeEvent) {
		const line = encoder.encode(`${JSON.stringify(encode(event))}\n`);
		for (const stream of streams) {
			try {
				stream.enqueue(line);
			} catch {
				streams.delete(stream);
			}
		}
	}

	// ── Git snapshot, with commits the host itself refused ─────────────────
	let injectedCommit: (CommitOutcome & { at: number }) | undefined;

	function snapshotView(snapshot: GitSnapshot = folder.git.snapshot) {
		const real = snapshot.lastCommit;
		const lastCommit =
			injectedCommit !== undefined &&
			(real === undefined || injectedCommit.at >= real.at)
				? injectedCommit
				: real;
		// The host requests automatic history after every content save.
		return { ...snapshot, commitOnEdit: true, lastCommit };
	}

	const unsubscribe = folder.git.subscribe((snapshot) =>
		broadcast({ type: 'git', snapshot: snapshotView(snapshot) }),
	);

	/** Ask for a commit of the saved files. Never awaited by a save. */
	function requestCommit() {
		if (faults.takeCommitFailure()) {
			injectedCommit = {
				status: 'failed',
				error: 'Injected commit failure',
				at: Date.now(),
			};
			broadcast({ type: 'git', snapshot: snapshotView() });
			return;
		}
		void folder.git.commit();
	}

	// A new folder's first commit is its layout, so a note's first commit is its own.
	if (folder.git.snapshot.sync.state !== 'observed')
		await folder.git.status().catch(() => undefined);
	if (
		(await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'])).code !== 0
	)
		await folder.git.commit();

	const watcher = await createWatcher(
		root,
		() => broadcast({ type: 'files' }),
		{ intervalMs: options.watchIntervalMs },
	);
	const ping = setInterval(() => broadcast({ type: 'ping' }), 15_000);

	// ── /bridge/call ───────────────────────────────────────────────────────
	async function call({ path, args }: CallRequest): Promise<unknown> {
		if (
			!Array.isArray(path) ||
			!path.every((part) => typeof part === 'string') ||
			!Array.isArray(args) ||
			!isAllowedCall(path)
		)
			throw new Error(`Not a folder method: ${JSON.stringify(path)}`);
		const [namespace, second, third] = path as [string, string, string?];
		if (namespace === 'git' && second === 'snapshot') return snapshotView();

		const method = namespace === 'tables' ? third! : second;
		const write =
			(namespace === 'tables' || namespace === 'files') &&
			CONTENT_WRITES.has(method);
		if (write && !(await faults.beforeSave()))
			return {
				data: null,
				error: {
					name: 'Io',
					message: 'Could not save: injected save failure',
					path: '',
					operation: 'save',
					cause: 'injected',
				},
			};
		const target: Record<string, (...args: unknown[]) => unknown> =
			namespace === 'tables'
				? (folder.tables as never)[second]
				: (folder as never)[namespace];

		const result = (await target[method]!(...args)) as { error?: unknown };
		if (write && result?.error === null) requestCommit();
		return result;
	}

	// ── /bridge/app ────────────────────────────────────────────────────────
	async function app(request: AppRequest): Promise<unknown> {
		switch (request.op) {
			case 'info':
				return {
					root,
					faults: faults.enabled,
					shell: options.toShell !== undefined,
				} satisfies HostInfo;
			case 'terminal': {
				const reply = await runTerminalCommand({
					root,
					command: String(request.command),
					cwd: String(request.cwd || root),
				});
				// A command may have changed files; do not wait for the timer.
				void watcher.scan();
				return reply;
			}
			case 'reveal': {
				const opener =
					process.platform === 'darwin'
						? 'open'
						: process.platform === 'win32'
							? 'explorer'
							: 'xdg-open';
				return new Promise<string | undefined>((resolve) => {
					const child = spawn(opener, [root], { stdio: 'ignore' });
					child.on('error', (cause) => resolve(cause.message));
					child.on('spawn', () => resolve(undefined));
				});
			}
			case 'faults':
				return faults.state();
			case 'setFaults':
				if (!faults.enabled)
					throw new Error('Fault injection is not enabled for this folder.');
				faults.set(request.faults ?? {});
				return faults.state();
			case 'fileLog': {
				const problem = pathProblem(String(request.path));
				if (problem !== undefined) throw new Error(problem);
				const depth = Math.min(Math.max(Number(request.depth) || 20, 1), 200);
				const log = await git(root, [
					'--literal-pathspecs',
					'log',
					`-n${depth}`,
					'--format=%H%x1f%at%x1f%s',
					'--',
					request.path,
				]);
				// A folder with no commits yet has no history to list.
				if (log.code !== 0) return [];
				return log.stdout
					.split('\n')
					.filter(Boolean)
					.map((line): FileRevision => {
						const [oid, timestamp, subject] = line.split('\x1f');
						return {
							oid: oid!,
							timestamp: Number(timestamp),
							subject: subject ?? '',
						};
					});
			}
			case 'show': {
				const problem = pathProblem(String(request.path));
				if (problem !== undefined) throw new Error(problem);
				if (!/^[0-9a-f]{7,64}$/.test(String(request.oid)))
					throw new Error('Not a commit id.');
				const shown = await git(root, [
					'show',
					`${request.oid}:${request.path}`,
				]);
				if (shown.code !== 0) throw new Error(shown.stderr.trim());
				return shown.stdout;
			}
			case 'closeReceived':
				closePending = false;
				return undefined;
			case 'quit':
				options.toShell?.({ quit: true });
				return undefined;
			default:
				throw new Error('Not a host operation.');
		}
	}

	// ── The page ───────────────────────────────────────────────────────────
	let index: { html: string; csp: string } | undefined;

	async function indexPage() {
		if (index !== undefined || uiDist === undefined) return index;
		let html = await readFile(join(uiDist, 'index.html'), 'utf8');
		if (options.pageToken)
			html = html.replace(
				'<head>',
				`<head><script>window.__HONEYCRISP_BRIDGE__=${JSON.stringify({ token })}</script>`,
			);
		// The page's own inline scripts are allowed by hash; nothing else inline is.
		const hashes = [
			...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g),
		].map(
			(match) =>
				`'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`,
		);
		index = {
			html,
			csp: [
				"default-src 'self'",
				`script-src 'self' ${hashes.join(' ')}`.trim(),
				"style-src 'self' 'unsafe-inline'",
				"img-src 'self' data: blob:",
				"connect-src 'self'",
				"object-src 'none'",
				"base-uri 'self'",
				"frame-ancestors 'none'",
			].join('; '),
		};
		return index;
	}

	async function page(pathname: string): Promise<Response> {
		if (uiDist === undefined) return new Response('Not found', { status: 404 });
		const relative = normalize(decodeURIComponent(pathname)).replace(
			/^[/\\]+/,
			'',
		);
		const file = join(uiDist, relative);
		if (
			relative !== '' &&
			!relative.split(sep).includes('..') &&
			extname(relative) !== '' &&
			(await stat(file).then(
				(stats) => stats.isFile(),
				() => false,
			))
		)
			return new Response(await readFile(file), {
				headers: {
					'content-type':
						TYPES[extname(relative)] ?? 'application/octet-stream',
					'cache-control': 'no-store',
				},
			});
		if (extname(relative) !== '' && relative !== 'index.html')
			return new Response('Not found', { status: 404 });
		const built = await indexPage();
		return new Response(built!.html, {
			headers: {
				'content-type': TYPES['.html']!,
				'content-security-policy': built!.csp,
				'cache-control': 'no-store',
			},
		});
	}

	const json = (body: unknown, status = 200) =>
		new Response(JSON.stringify(body), {
			status,
			headers: {
				'content-type': 'application/json',
				'cache-control': 'no-store',
			},
		});

	function authorized(request: Request): boolean {
		const header = request.headers.get('authorization') ?? '';
		const given = Buffer.from(header.replace(/^Bearer /, ''));
		const expected = Buffer.from(token);
		return given.length === expected.length && timingSafeEqual(given, expected);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (origin !== undefined) {
			// A page from another origin, or a name that merely resolves here, is refused.
			if (request.headers.get('host') !== new URL(origin).host)
				return json({ fault: 'Wrong host' }, 421);
			const from = request.headers.get('origin');
			if (from !== null && from !== origin)
				return json({ fault: 'Wrong origin' }, 403);
		}
		if (!url.pathname.startsWith('/bridge/')) {
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response('Method not allowed', { status: 405 });
			return page(url.pathname);
		}
		if (!authorized(request)) return json({ fault: 'Unauthorized' }, 401);
		if (url.pathname === '/bridge/events' && request.method === 'GET') {
			let mine: ReadableStreamDefaultController<Uint8Array> | undefined;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					mine = controller;
					streams.add(controller);
					controller.enqueue(
						encoder.encode(
							`${JSON.stringify(encode({ type: 'git', snapshot: snapshotView() }))}\n`,
						),
					);
					// A close during startup or a stream disconnect still needs
					// the mounted page's answer when it reconnects.
					if (closePending)
						controller.enqueue(
							encoder.encode(`${JSON.stringify({ type: 'closeRequested' })}\n`),
						);
				},
				cancel() {
					if (mine) streams.delete(mine);
				},
			});
			return new Response(body, {
				headers: {
					'content-type': 'application/x-ndjson',
					'cache-control': 'no-store',
				},
			});
		}
		if (request.method !== 'POST')
			return json({ fault: 'Method not allowed' }, 405);
		let body: unknown;
		try {
			body = decode(await request.json());
		} catch {
			return json({ fault: 'The request body is not JSON' }, 400);
		}
		try {
			if (url.pathname === '/bridge/call')
				return json({ ok: encode(await call(body as CallRequest)) });
			if (url.pathname === '/bridge/app')
				return json({ ok: encode(await app(body as AppRequest)) });
		} catch (cause) {
			return json({
				fault: cause instanceof Error ? cause.message : String(cause),
			});
		}
		return json({ fault: 'Not found' }, 404);
	}

	return {
		root,
		fetch: handle,
		/** Fix the origin once the socket is bound. */
		bind(bound: string) {
			origin = bound;
		},
		/** The shell held back a close or quit; ask the page to settle its drafts. */
		closeRequested() {
			closePending = true;
			broadcast({ type: 'closeRequested' });
		},
		/** Compare the directory now instead of at the next timer tick. */
		scan: () => watcher.scan(),
		async close() {
			clearInterval(ping);
			watcher.close();
			unsubscribe();
			faults.set({ holdSaves: false });
			for (const stream of streams) {
				try {
					stream.close();
				} catch {
					// Already closed by its reader.
				}
			}
			streams.clear();
			await folder.close();
		},
	};
}
