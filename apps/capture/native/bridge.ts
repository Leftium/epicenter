/**
 * The Capture folder bridge: the HTTP face of the one folder owner.
 *
 * `createCaptureBridge` returns a `fetch` handler for the two routes below
 * `/_epicenter/capture`. The Epicenter host mounts it behind its own browser
 * session and Origin checks; this module adds no credential of its own and
 * names no directory a request could choose. The directory comes from native
 * startup, once.
 *
 * Importing this module opens nothing. The first request acquires the owner.
 * The handler holds no per-page state: a call lives as long as its request,
 * and an event subscription lives as long as its stream.
 */
import { decode, encode } from '../src/lib/bridge/codec.js';
import {
	BRIDGE_PATH,
	type BridgeEvent,
	type BridgeReply,
	type CallRequest,
} from '../src/lib/bridge/contract.js';
import {
	type CaptureOwnerOptions,
	createCaptureOwner,
	OWNER_CLOSED,
	RefusedCallError,
} from './owner.js';
import { RootBusyError } from './root-lock.js';

export type CaptureBridgeOptions = CaptureOwnerOptions & {
	/**
	 * How often an open event stream says it is alive. Must stay under the
	 * server's idle timeout, which would otherwise close a quiet stream; Bun's
	 * default is ten seconds.
	 */
	readonly pingIntervalMs?: number;
};

export type CaptureBridge = ReturnType<typeof createCaptureBridge>;

/** A 64 MB source plus its envelope; anything larger is not a save. */
const MAX_BODY_BYTES = 96 * 1024 * 1024;

function json(reply: BridgeReply, status: number): Response {
	return new Response(JSON.stringify(reply), {
		status,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
		},
	});
}

/** Why a call or a stream could not start, and the status that says so. */
function fault(cause: unknown): Response {
	if (cause instanceof RefusedCallError)
		return json(
			{ fault: cause.message },
			cause.message === OWNER_CLOSED ? 503 : 400,
		);
	if (cause instanceof RootBusyError)
		return json({ fault: cause.message }, 409);
	return json(
		{
			fault: `The Capture folder could not be used: ${cause instanceof Error ? cause.message : String(cause)}`,
		},
		500,
	);
}

export function createCaptureBridge(options: CaptureBridgeOptions) {
	const owner = createCaptureOwner(options);
	const pingIntervalMs = options.pingIntervalMs ?? 4000;
	const encoder = new TextEncoder();
	const line = (event: BridgeEvent) =>
		encoder.encode(`${JSON.stringify(encode(event))}\n`);

	async function call(request: Request): Promise<Response> {
		const length = Number(request.headers.get('content-length') ?? 0);
		if (length > MAX_BODY_BYTES)
			return json({ fault: 'The request is too large.' }, 413);
		let body: unknown;
		try {
			body = decode(await request.json());
		} catch {
			return json({ fault: 'The request body is not a bridge value.' }, 400);
		}
		try {
			return json({ ok: encode(await owner.call(body as CallRequest)) }, 200);
		} catch (cause) {
			return fault(cause);
		}
	}

	async function events(request: Request): Promise<Response> {
		let stop = () => {};
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			stop();
			try {
				controller.close();
			} catch {
				// Already closed by its reader.
			}
		};
		const body = new ReadableStream<Uint8Array>({
			start(started) {
				controller = started;
			},
			cancel() {
				ended = true;
				stop();
			},
		});
		const send = (event: BridgeEvent) => {
			if (ended) return;
			try {
				controller.enqueue(line(event));
			} catch {
				end();
			}
		};
		try {
			const unsubscribe = await owner.subscribe({ event: send, end });
			const ping = setInterval(() => send({ type: 'ping' }), pingIntervalMs);
			stop = () => {
				clearInterval(ping);
				unsubscribe();
				request.signal.removeEventListener('abort', end);
			};
			// The reader, or the page, left while the folder was still opening.
			if (ended) stop();
			else if (request.signal.aborted) end();
			else request.signal.addEventListener('abort', end, { once: true });
		} catch (cause) {
			return fault(cause);
		}
		return new Response(body, {
			headers: {
				'content-type': 'application/x-ndjson',
				'cache-control': 'no-store',
			},
		});
	}

	return {
		/** The canonical route prefix this handler answers below. */
		path: BRIDGE_PATH,
		/** Answer one already-authorized request. */
		async fetch(request: Request): Promise<Response> {
			const { pathname } = new URL(request.url);
			if (pathname === `${BRIDGE_PATH}/call`)
				return request.method === 'POST'
					? call(request)
					: json({ fault: 'Method not allowed' }, 405);
			if (pathname === `${BRIDGE_PATH}/events`)
				return request.method === 'GET'
					? events(request)
					: json({ fault: 'Method not allowed' }, 405);
			return json({ fault: 'Not found' }, 404);
		},
		/** Compare the directory now instead of at the next timer tick. */
		scan: () => owner.scan(),
		/**
		 * Fence new requests, end every event stream, let admitted work finish,
		 * and release the directory. The folder is closed here and nowhere else.
		 */
		close: () => owner.close(),
	};
}
