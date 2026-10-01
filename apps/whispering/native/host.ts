/**
 * The Whispering folder host: the one native process that touches the data
 * folder.
 *
 * It opens the directory as a file folder, serves the built page, and answers
 * the page's bridge calls on loopback. The page reaches recordings, settings,
 * history, the terminal, and transcription only through here, so no Node or
 * Bun module is in the page bundle.
 *
 * `handle` is a plain `Request -> Response` function. `main.ts` binds it to a
 * port; tests call it directly.
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import type { DataDefinition } from '@epicenter/app/definition';
import type { Folder } from '@epicenter/app/files';
import { openNativeFolder } from '@epicenter/app/files/native';
import { audioMimeTypeOf } from '../src/lib/audio-format.js';
import { decode, encode } from '../src/lib/bridge/codec.js';
import {
	DEFAULT_TRANSCRIPTION_SETTINGS,
	whisperingDefinition,
} from '../src/lib/definition.js';
import {
	requestTranscription,
	TranscriptionError,
} from '../src/lib/transcription.js';
import {
	createFailureInjection,
	type FailureInjection,
} from './failure-injection.js';
import { callFolder, UnknownFolderCall } from './folder-rpc.js';
import { createShellTerminal } from './terminal.js';
import { watchFolder } from './watch.js';

export type HostOptions = {
	/** The data folder. Created when absent. */
	readonly root: string;
	/** The per-launch credential every bridge request must carry. */
	readonly token: string;
	/** The built page, or undefined to serve only the bridge. */
	readonly uiDist: string | undefined;
	/** Set by a debug shell. Enables fixture audio and failure injection. */
	readonly debug: boolean;
	readonly fixturePath: string | undefined;
	/**
	 * Write the token into the served page. Only for running the host without
	 * the desktop shell, which otherwise injects it.
	 */
	readonly inlineToken: boolean;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly log: (message: string) => void;
	/**
	 * Called when the window may close, which is only when the page said so.
	 * The entry point tells the shell.
	 */
	readonly onCloseApproved?: () => void;
	/** Injected in tests; transcription requests leave through it. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type HostInfo = {
	readonly root: string;
	readonly platform: string;
	readonly shell: string;
	readonly debug: boolean;
	readonly fixture: { readonly name: string; readonly size: number } | null;
	/** A fixture was requested from a shell that does not allow one. */
	readonly fixtureRefused: boolean;
	readonly defaults: {
		readonly transcriptionBaseUrl: string;
		readonly transcriptionModel: string;
	};
	readonly credentialPresent: boolean;
	/** Whether the key comes from the environment and cannot be changed here. */
	readonly credentialFromEnvironment: boolean;
};

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
};

/** The page talks only to this host; transcription requests leave from the host. */
const PAGE_POLICY = [
	"default-src 'self'",
	"connect-src 'self'",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
].join('; ');

const PING_MS = 15_000;

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export async function createHost(options: HostOptions) {
	await mkdir(options.root, { recursive: true });
	const folder = await openNativeFolder({
		root: options.root,
		definition: whisperingDefinition,
		git: { author: { name: 'Whispering', email: 'whispering@localhost' } },
	});
	// The folder resolved its root; use the same spelling everywhere after.
	const root = await realpath(options.root);
	const anyFolder = folder as unknown as Folder<DataDefinition>;
	const terminal = createShellTerminal(root);
	const deviceFile = join(
		root,
		'.git',
		'epicenter',
		'whispering',
		'device.json',
	);
	const encoder = new TextEncoder();

	let injection: FailureInjection | undefined;
	if (options.debug) {
		injection = createFailureInjection({ root, folder: anyFolder });
		const initial = {
			rowWrites: Number(options.env.WHISPERING_DEBUG_FAIL_ROW_WRITES ?? 0),
			audioWrites: Number(options.env.WHISPERING_DEBUG_FAIL_AUDIO_WRITES ?? 0),
			commitsBlocked: options.env.WHISPERING_DEBUG_BLOCK_COMMITS === '1',
		};
		// A lock someone else holds is theirs; start without the injected one.
		await injection
			.arm(initial)
			.catch((cause) => options.log(`Failure injection: ${describe(cause)}`));
	}

	async function fixtureInfo(): Promise<HostInfo['fixture']> {
		if (!options.debug || options.fixturePath === undefined) return null;
		try {
			const stats = await stat(options.fixturePath);
			return { name: basename(options.fixturePath), size: stats.size };
		} catch (cause) {
			options.log(
				`The audio fixture at ${options.fixturePath} is not readable: ${describe(cause)}`,
			);
			return { name: basename(options.fixturePath), size: 0 };
		}
	}

	async function storedKey(): Promise<string> {
		try {
			const parsed: unknown = JSON.parse(await readFile(deviceFile, 'utf8'));
			if (
				typeof parsed === 'object' &&
				parsed !== null &&
				'transcriptionApiKey' in parsed &&
				typeof parsed.transcriptionApiKey === 'string'
			)
				return parsed.transcriptionApiKey;
		} catch {
			// No device file yet, or one that is not ours to read.
		}
		return '';
	}

	const environmentKey = options.env.WHISPERING_TRANSCRIPTION_API_KEY;
	const apiKey = async () => environmentKey ?? (await storedKey());

	// --- events -------------------------------------------------------------

	type Listener = (line: string) => void;
	const listeners = new Set<Listener>();
	const broadcast = (event: unknown) => {
		const line = `${JSON.stringify(encode(event))}\n`;
		for (const listener of listeners) listener(line);
	};
	const unsubscribe = folder.git.subscribe((snapshot) =>
		broadcast({ type: 'git', snapshot }),
	);
	const unwatch = watchFolder(
		root,
		() => broadcast({ type: 'files' }),
		(cause) => options.log(`Folder watching stopped: ${describe(cause)}`),
	);
	const ping = setInterval(() => broadcast({ type: 'ping' }), PING_MS);

	function events(): Response {
		let listener: Listener | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				listener = (line) => {
					try {
						controller.enqueue(encoder.encode(line));
					} catch {
						if (listener) listeners.delete(listener);
					}
				};
				listeners.add(listener);
				listener(
					`${JSON.stringify(encode({ type: 'git', snapshot: folder.git.snapshot }))}\n`,
				);
				// A close asked while the stream was down is still waiting for an answer.
				if (closePending)
					listener(`${JSON.stringify({ type: 'close-requested' })}\n`);
			},
			cancel() {
				if (listener) listeners.delete(listener);
			},
		});
		return new Response(stream, {
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'cache-control': 'no-store',
			},
		});
	}

	// --- closing ------------------------------------------------------------
	//
	// Unsaved typing and captured audio live only in the page, so only the page
	// can say whether closing loses anything. The shell asks through here before
	// it closes the window or quits, and closes only when this approves.

	// Approval is never inferred, from anything. A page can be using the folder
	// and holding unsaved work while its event stream is slow, dropped, or has
	// not connected yet, so whether a stream is or ever was open says nothing
	// about what the page holds. The host approves a close only on the page's
	// own authenticated `proceed`. A request with no stream to carry it waits
	// and is delivered when one connects.

	/** A close request the page has not settled with proceed or cancel. */
	let closePending = false;

	function approveClose() {
		closePending = false;
		options.onCloseApproved?.();
	}

	/** The shell wants to close. Ask the page, now or when its stream connects. */
	function closeRequested() {
		closePending = true;
		broadcast({ type: 'close-requested' });
	}

	function closeAnswered(payload: Record<string, unknown>) {
		switch (payload.decision) {
			case 'proceed':
				approveClose();
				return { closing: true };
			case 'asking':
				return { closing: false };
			case 'cancel':
				closePending = false;
				return { closing: false };
			default:
				throw new Error('A close answer is proceed, asking, or cancel');
		}
	}

	// --- application operations --------------------------------------------

	async function info(): Promise<HostInfo> {
		return {
			root,
			platform: process.platform,
			shell: terminal.shell,
			debug: options.debug,
			fixture: await fixtureInfo(),
			fixtureRefused: !options.debug && options.fixturePath !== undefined,
			defaults: {
				transcriptionBaseUrl:
					options.env.WHISPERING_TRANSCRIPTION_BASE_URL ??
					DEFAULT_TRANSCRIPTION_SETTINGS.transcriptionBaseUrl,
				transcriptionModel:
					options.env.WHISPERING_TRANSCRIPTION_MODEL ??
					DEFAULT_TRANSCRIPTION_SETTINGS.transcriptionModel,
			},
			credentialPresent: (await apiKey()) !== '',
			credentialFromEnvironment: environmentKey !== undefined,
		};
	}

	async function reveal() {
		const [command, args] =
			process.platform === 'darwin'
				? ['open', [root]]
				: process.platform === 'win32'
					? ['explorer', [root]]
					: ['xdg-open', [root]];
		await new Promise<void>((settle, fail) => {
			const child = spawn(command as string, args as string[], {
				stdio: 'ignore',
				detached: true,
			});
			child.on('error', fail);
			child.on('spawn', () => {
				child.unref();
				settle();
			});
		});
		return { revealed: root };
	}

	async function transcribe(payload: Record<string, unknown>) {
		const path = String(payload.path ?? '');
		const read = await folder.files.read(path);
		if (read.error)
			return TranscriptionError.AudioUnreadable({
				path,
				reason: read.error.message,
			});
		return requestTranscription({
			baseUrl: String(payload.baseUrl ?? ''),
			model: String(payload.model ?? ''),
			apiKey: await apiKey(),
			fetch: options.fetch,
			audio: {
				bytes: read.data.bytes,
				filename: basename(path),
				mimeType: audioMimeTypeOf(path) ?? 'application/octet-stream',
			},
		});
	}

	async function setCredential(payload: Record<string, unknown>) {
		if (environmentKey !== undefined)
			throw new Error(
				'The transcription key comes from WHISPERING_TRANSCRIPTION_API_KEY and cannot be changed here.',
			);
		const key = String(payload.key ?? '');
		await mkdir(join(deviceFile, '..'), { recursive: true });
		await writeFile(
			deviceFile,
			`${JSON.stringify({ transcriptionApiKey: key }, null, 2)}\n`,
			{ mode: 0o600 },
		);
		return { present: key !== '' };
	}

	async function fixture() {
		if (!options.debug || options.fixturePath === undefined)
			throw new Error('Fixture audio is only available in a debug shell.');
		return {
			name: basename(options.fixturePath),
			bytes: new Uint8Array(await readFile(options.fixturePath)),
		};
	}

	async function app(op: string, payload: Record<string, unknown>) {
		switch (op) {
			case 'info':
				return info();
			case 'terminal':
				return terminal.exec({
					command: String(payload.command ?? ''),
					cwd: String(payload.cwd ?? ''),
				});
			case 'reveal':
				return reveal();
			case 'transcribe':
				return transcribe(payload);
			case 'credential':
				return setCredential(payload);
			case 'close':
				return closeAnswered(payload);
			case 'fixture':
				return fixture();
			case 'inject':
				if (injection === undefined)
					throw new Error(
						'Failure injection is only available in a debug shell.',
					);
				return injection.arm(payload);
			case 'injection':
				if (injection === undefined)
					throw new Error(
						'Failure injection is only available in a debug shell.',
					);
				return injection.state;
			default:
				throw new Error(`'${op}' is not a Whispering host operation`);
		}
	}

	// --- static page --------------------------------------------------------

	async function page(pathname: string): Promise<Response> {
		const dist = options.uiDist;
		if (dist === undefined)
			return new Response('This host serves only the folder bridge.', {
				status: 404,
			});
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			return new Response('Bad request', { status: 400 });
		}
		const base = resolve(dist);
		let file = resolve(base, `.${decoded}`);
		if (file !== base && !file.startsWith(base + sep))
			return new Response('Not found', { status: 404 });
		const isFile = await stat(file).then(
			(stats) => stats.isFile(),
			() => false,
		);
		if (!isFile) {
			// A missing asset is missing; any other path is a page of the SPA.
			if (decoded.startsWith('/_app/') || extname(decoded) !== '')
				return new Response('Not found', { status: 404 });
			file = join(base, 'index.html');
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(file));
		} catch {
			return new Response(
				'The Whispering page has not been built. Run `bun run build` in apps/whispering.',
				{ status: 503 },
			);
		}
		const html = extname(file) === '.html';
		if (html && options.inlineToken) {
			const script = `<script>window.__WHISPERING_BRIDGE__=${JSON.stringify({ token: options.token })};</script>`;
			bytes = encoder.encode(
				new TextDecoder().decode(bytes).replace('<head>', `<head>${script}`),
			);
		}
		return new Response(bytes as Uint8Array<ArrayBuffer>, {
			headers: {
				'content-type':
					CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
				'cache-control': decoded.startsWith('/_app/immutable/')
					? 'public, max-age=31536000, immutable'
					: 'no-store',
				...(html && { 'content-security-policy': PAGE_POLICY }),
				'x-content-type-options': 'nosniff',
			},
		});
	}

	// --- request handling ---------------------------------------------------

	let port: number | undefined;
	const expectedToken = Buffer.from(`Bearer ${options.token}`);

	function authorized(request: Request): boolean {
		const offered = Buffer.from(request.headers.get('authorization') ?? '');
		return (
			offered.length === expectedToken.length &&
			timingSafeEqual(offered, expectedToken)
		);
	}

	/** Refuse a request that reached this port under another name or from another page. */
	function local(request: Request): boolean {
		if (port === undefined) return true;
		const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
		const host = request.headers.get('host');
		if (host !== null && !hosts.includes(host)) return false;
		const origin = request.headers.get('origin');
		return origin === null || hosts.some((name) => origin === `http://${name}`);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!local(request)) return new Response('Forbidden', { status: 403 });
		if (!url.pathname.startsWith('/bridge/')) {
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response('Method not allowed', { status: 405 });
			return page(url.pathname);
		}
		if (!authorized(request)) return json({ fault: 'Unauthorized' }, 401);
		if (url.pathname === '/bridge/events' && request.method === 'GET')
			return events();
		if (request.method !== 'POST')
			return json({ fault: 'Method not allowed' }, 405);
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return json({ fault: 'The request body is not JSON' }, 400);
		}
		try {
			if (url.pathname === '/bridge/call') {
				const path = body.path;
				const args = decode(body.args);
				if (
					!Array.isArray(path) ||
					!path.every((part) => typeof part === 'string') ||
					!Array.isArray(args)
				)
					return json({ fault: 'A call needs a path and arguments' }, 400);
				const intercepted = await injection?.intercept(path, args);
				const result =
					intercepted === undefined
						? await callFolder(anyFolder, path, args)
						: intercepted.value;
				return json({ ok: encode(result) });
			}
			if (url.pathname === '/bridge/app') {
				const payload = decode(body.payload ?? {}) as Record<string, unknown>;
				return json({ ok: encode(await app(String(body.op), payload)) });
			}
		} catch (cause) {
			if (!(cause instanceof UnknownFolderCall))
				options.log(`Bridge call failed: ${describe(cause)}`);
			return json(
				{ fault: describe(cause) },
				cause instanceof UnknownFolderCall ? 404 : 500,
			);
		}
		return json({ fault: 'Not found' }, 404);
	}

	return {
		root,
		folder,
		handle,
		closeRequested,
		/** The bound port, so requests under another host name are refused. */
		listening(bound: number) {
			port = bound;
		},
		/** Settle admitted saves and the running commit pass, then release. */
		async close() {
			clearInterval(ping);
			unwatch();
			unsubscribe();
			listeners.clear();
			await injection?.release();
			await folder.close();
		},
	};
}

export type Host = Awaited<ReturnType<typeof createHost>>;
