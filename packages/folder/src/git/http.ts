/**
 * An isomorphic-git HTTP client over `fetch` that honors an abort signal.
 *
 * The bundled web client ignores cancellation. Passing the owner's signal to
 * `fetch` lets closing the folder stop an in-flight push or fetch transport.
 */
import type { GitHttpRequest, HttpClient } from 'isomorphic-git';

/** HTTP capability used for this folder's Git requests. */
export type HttpFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

async function collect(
	body: GitHttpRequest['body'],
): Promise<Uint8Array | undefined> {
	if (body === undefined) return undefined;
	const chunks: Uint8Array[] = [];
	let size = 0;
	for await (const chunk of body) {
		chunks.push(chunk);
		size += chunk.byteLength;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

async function* chunks(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export function abortableHttp(
	signal: AbortSignal,
	httpFetch: HttpFetch = globalThis.fetch,
): HttpClient {
	return {
		async request({ url, method = 'GET', headers = {}, body }) {
			const payload = await collect(body);
			const response = await httpFetch(url, {
				method,
				headers,
				body: payload as Uint8Array<ArrayBuffer> | undefined,
				signal,
			});
			return {
				url: response.url,
				method,
				statusCode: response.status,
				statusMessage: response.statusText,
				headers: Object.fromEntries(response.headers),
				body: response.body ? chunks(response.body) : (async function* () {})(),
			};
		},
	};
}
