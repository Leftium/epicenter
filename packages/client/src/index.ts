/**
 * `@epicenter/client`: typed HTTP client for the Epicenter server.
 *
 * Wraps `assets`, `blobs`, and `session` surfaces. Composes on
 * `AuthFetch` from `@epicenter/auth`, which handles OAuth bearer attach,
 * refresh, and 401 propagation. This package does not own auth state;
 * it consumes the authed fetch handle.
 *
 * Works against any Epicenter deployment (cloud at `epicenter.so` or a
 * self-hosted shared-wiki server).
 */

import type { ApiSessionResponse, AuthFetch } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { OwnerId } from '@epicenter/identity';

export type {
	AgentEngine,
	AgentEngineRequest,
	AgentEngineToolDefinition,
	EngineChunk,
	EngineFetch,
	ModelMessage,
	ModelToolCall,
} from './agent-engine.js';
export {
	type InferenceBackendConfig,
	type ResolvedInferenceBackend,
	resolveInferenceBackend,
} from './inference-backend.js';
export {
	createOpenAiAgentEngine,
	type OpenAiTurnContext,
} from './openai-provider.js';

export type EpicenterClientOptions = {
	/** Base URL of the Epicenter server (no trailing slash required). */
	baseURL: string;
	/**
	 * Authenticated fetch. Produced by `createOAuthAppAuth({...}).fetch`
	 * from `@epicenter/auth`. The client does not own auth lifecycle.
	 */
	fetch: AuthFetch;
};

// ---------------------------------------------------------------------------
// Asset types (mirror the server response shapes)
// ---------------------------------------------------------------------------

export type AssetVisibility = 'private' | 'public';

export type UploadAssetResponse = {
	id: string;
	/** Server-relative URL: `/api/owners/<ownerId>/assets/<assetId>`. */
	url: string;
	visibility: AssetVisibility;
	contentType: string;
	size: number;
	originalName: string;
};

export type AssetRow = {
	id: string;
	ownerId: OwnerId;
	contentType: string;
	sizeBytes: number;
	originalName: string;
	visibility: AssetVisibility;
	uploadedAt: string;
};

export type SetVisibilityResponse = {
	id: string;
	visibility: AssetVisibility;
};

// ---------------------------------------------------------------------------
// Blob types (content-addressed store; mirror the server response shapes)
// ---------------------------------------------------------------------------

/** One row of the owner's blob listing (`GET /blobs`). */
export type BlobRow = { sha256: string; size: number; uploaded: string };

/** Total stored bytes for the owner (`GET /blobs/usage`). */
export type BlobUsage = { totalBytes: number };

/** Result of the client's `blobs.add`. */
export type AddBlobResult = {
	/** Lowercase-hex content address of the stored bytes. */
	sha256: string;
	/** Content-addressed read URL (`GET /blobs/:sha256`, a 302 to a presigned GET). */
	url: string;
	/** True when the object already existed, so no bytes were uploaded. */
	duplicate: boolean;
};

/**
 * Upload-ticket response from `POST /blobs`. The server either reports the
 * object already exists (`duplicate`) or returns a presigned PUT plus the
 * headers the client must echo verbatim (`upload`). Internal to `blobs.add`.
 */
type BlobTicket =
	| { status: 'duplicate'; sha256: string; key: string; url: string }
	| {
			status: 'upload';
			sha256: string;
			key: string;
			url: string;
			uploadUrl: string;
			requiredHeaders: Record<string, string>;
			expiresInSeconds: number;
	  };

/**
 * Hex sha256 of a byte buffer via the platform WebCrypto (`crypto.subtle`),
 * present on browsers, Node 18+, and Workers. This hex digest IS the blob's
 * content address; the server derives the base64 `x-amz-checksum-sha256` the
 * store enforces from the same digest.
 */
async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a typed Epicenter client bound to a base URL and an authed fetch.
 *
 * Lazy-fetches `/api/session` on first call to resolve `ownerId`, then
 * caches it so subsequent URL builds are synchronous. Apps that need a
 * URL before the first async call should `await epicenter.ready()` at
 * boot.
 */
export function createEpicenterClient(opts: EpicenterClientOptions) {
	const base = opts.baseURL.replace(/\/+$/, '');
	let cachedSession: ApiSessionResponse | null = null;

	async function getSession(): Promise<ApiSessionResponse> {
		if (cachedSession) return cachedSession;
		const res = await opts.fetch(API_ROUTES.session.url(base));
		if (!res.ok) {
			throw new Error(`epicenter: /api/session returned ${res.status}`);
		}
		cachedSession = (await res.json()) as ApiSessionResponse;
		return cachedSession;
	}

	async function getOwnerId(): Promise<OwnerId> {
		return (await getSession()).ownerId;
	}

	const session = {
		/** Read the cached session, fetching once if needed. */
		current: getSession,
		/** Force a re-fetch of `/api/session` and update the cache. */
		async refresh(): Promise<ApiSessionResponse> {
			cachedSession = null;
			return getSession();
		},
	};

	const assets = {
		async upload(
			file: File,
			params: { visibility?: AssetVisibility } = {},
		): Promise<UploadAssetResponse> {
			const ownerId = await getOwnerId();
			const fd = new FormData();
			fd.append('file', file);
			fd.append('visibility', params.visibility ?? 'private');
			const res = await opts.fetch(API_ROUTES.assets.list.url(base, ownerId), {
				method: 'POST',
				body: fd,
			});
			if (!res.ok) {
				throw new Error(`epicenter.assets.upload: ${res.status}`);
			}
			return (await res.json()) as UploadAssetResponse;
		},

		async list(): Promise<AssetRow[]> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.assets.list.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.assets.list: ${res.status}`);
			}
			return (await res.json()) as AssetRow[];
		},

		async usage(): Promise<{ totalBytes: number }> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.assets.usage.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.assets.usage: ${res.status}`);
			}
			return (await res.json()) as { totalBytes: number };
		},

		async setVisibility(
			id: string,
			visibility: AssetVisibility,
		): Promise<SetVisibilityResponse> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(
				API_ROUTES.assets.byId.url(base, ownerId, id),
				{
					method: 'PATCH',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ visibility }),
				},
			);
			if (!res.ok) {
				throw new Error(`epicenter.assets.setVisibility: ${res.status}`);
			}
			return (await res.json()) as SetVisibilityResponse;
		},

		async delete(id: string): Promise<void> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(
				API_ROUTES.assets.byId.url(base, ownerId, id),
				{ method: 'DELETE' },
			);
			if (!res.ok) {
				throw new Error(`epicenter.assets.delete: ${res.status}`);
			}
		},

		/**
		 * Build the full URL for an asset. Sync; requires the cached session
		 * (call `epicenter.ready()` once at boot if you need to build URLs
		 * before any other async call resolves).
		 *
		 * Useful for embedding in Yjs documents, `<img src>`, share buttons.
		 */
		url(id: string): string {
			if (!cachedSession) {
				throw new Error(
					'epicenter.assets.url: session not yet resolved. ' +
						'Call `await epicenter.ready()` once at app boot, or ' +
						'await any other assets.* method first.',
				);
			}
			return API_ROUTES.assets.byId.url(base, cachedSession.ownerId, id);
		},
	};

	const blobs = {
		/**
		 * Archive bytes in the content-addressed store: hash the bytes, mint an
		 * upload ticket, and (unless the object already exists) PUT the bytes
		 * straight to the store. Accepts a `File`/`Blob`, or an `http(s)` URL
		 * string to fetch first.
		 *
		 * The presigned PUT goes direct to the store with a plain `fetch`, not the
		 * authed one: the URL is self-authenticating and an extra bearer is not in
		 * the signed header set. The signed `x-amz-checksum-sha256` is echoed
		 * verbatim, so the object can only land under a key whose hash its bytes
		 * actually match (mismatch -> 400 BadDigest).
		 */
		async add(
			fileOrUrl: File | Blob | string,
			params: { contentType?: string } = {},
		): Promise<AddBlobResult> {
			const ownerId = await getOwnerId();

			let bytes: ArrayBuffer;
			let contentType: string;
			if (typeof fileOrUrl === 'string') {
				const source = await fetch(fileOrUrl);
				if (!source.ok) {
					throw new Error(
						`epicenter.blobs.add: fetch ${fileOrUrl} -> ${source.status}`,
					);
				}
				bytes = await source.arrayBuffer();
				contentType =
					params.contentType ??
					source.headers.get('content-type') ??
					'application/octet-stream';
			} else {
				bytes = await fileOrUrl.arrayBuffer();
				contentType =
					params.contentType || fileOrUrl.type || 'application/octet-stream';
			}

			const sha256 = await sha256Hex(bytes);

			const ticketRes = await opts.fetch(
				API_ROUTES.blobs.list.url(base, ownerId),
				{
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						sha256,
						sizeBytes: bytes.byteLength,
						contentType,
					}),
				},
			);
			if (!ticketRes.ok) {
				throw new Error(`epicenter.blobs.add: ticket -> ${ticketRes.status}`);
			}
			const ticket = (await ticketRes.json()) as BlobTicket;

			if (ticket.status === 'duplicate') {
				return { sha256, url: ticket.url, duplicate: true };
			}

			const put = await fetch(ticket.uploadUrl, {
				method: 'PUT',
				headers: ticket.requiredHeaders,
				body: bytes,
			});
			if (!put.ok) {
				const detail = await put.text().catch(() => '');
				throw new Error(
					`epicenter.blobs.add: store PUT -> ${put.status}${detail ? ` ${detail}` : ''}`,
				);
			}
			return { sha256, url: ticket.url, duplicate: false };
		},

		/**
		 * Build the content-addressed read URL for a blob. Sync and owner-explicit
		 * (unlike `assets.url`): a blob is referenced from a vault receipt that
		 * already records its owner, so the URL needs no cached session and can
		 * address any owner partition.
		 */
		url(ownerId: OwnerId, sha256: string): string {
			return API_ROUTES.blobs.byHash.url(base, ownerId, sha256);
		},

		/**
		 * Read a blob's bytes. The server answers 302 to a short-lived presigned
		 * GET; `fetch` follows it, and the cross-origin redirect drops the bearer
		 * so the presigned URL is hit clean. The caller reads the `Response`.
		 */
		async get(sha256: string): Promise<Response> {
			const ownerId = await getOwnerId();
			return opts.fetch(API_ROUTES.blobs.byHash.url(base, ownerId, sha256));
		},

		async list(): Promise<BlobRow[]> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.blobs.list.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.blobs.list: ${res.status}`);
			}
			return (await res.json()) as BlobRow[];
		},

		async usage(): Promise<BlobUsage> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(API_ROUTES.blobs.usage.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.blobs.usage: ${res.status}`);
			}
			return (await res.json()) as BlobUsage;
		},

		async delete(sha256: string): Promise<void> {
			const ownerId = await getOwnerId();
			const res = await opts.fetch(
				API_ROUTES.blobs.byHash.url(base, ownerId, sha256),
				{ method: 'DELETE' },
			);
			if (!res.ok) {
				throw new Error(`epicenter.blobs.delete: ${res.status}`);
			}
		},
	};

	return {
		/**
		 * Resolve and cache the session. Call once at app boot if any code
		 * path uses synchronous URL builders like `assets.url(id)` before
		 * an awaited async call.
		 */
		async ready(): Promise<void> {
			await getSession();
		},
		assets,
		blobs,
		session,
	};
}

export type EpicenterClient = ReturnType<typeof createEpicenterClient>;
