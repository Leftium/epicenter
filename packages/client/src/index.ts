/**
 * `@epicenter/client`: typed HTTP client for the Epicenter server.
 *
 * Owner-scoped data surfaces (`assets`, `blobs`) over `AuthFetch` from
 * `@epicenter/auth`, which handles OAuth bearer attach, refresh, and 401
 * propagation. This package owns neither auth state nor identity: the caller
 * passes the authed fetch handle and the `ownerId` (read from `auth.state`),
 * so the client never fetches `/api/session` itself. Profile reads live on the
 * auth client (`auth.getProfile()`); see ADR-0058.
 *
 * Works against any Epicenter deployment (cloud at `epicenter.so` or a
 * self-hosted shared-wiki server).
 */

import type { AuthFetch } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import type { OwnerId } from '@epicenter/identity';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';

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
	/**
	 * The signed-in owner partition, read from `auth.state.ownerId`. The client
	 * is owner-scoped and addresses every route under it; it never resolves
	 * identity itself. (`blobs.url` stays owner-explicit so a vault receipt can
	 * address any owner's blob.)
	 */
	ownerId: OwnerId;
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
 * Failure modes of the Result-returning client surfaces (`blobs.*`). The
 * retiring `assets.*` stays throw-native: it is slice-6 dead code that `blobs`
 * supersedes, not worth converting.
 */
export const ClientError = defineErrors({
	/** The transport itself failed: network down, DNS, aborted, CORS. */
	TransportFailed: ({
		operation,
		cause,
	}: {
		operation: string;
		cause: unknown;
	}) => ({
		message: `${operation}: ${extractErrorMessage(cause)}`,
		operation,
		cause,
	}),
	/** A request reached the server/store but returned a non-2xx status. */
	RequestFailed: ({
		operation,
		status,
		detail,
	}: {
		operation: string;
		status: number;
		detail?: string;
	}) => ({
		message: `${operation} failed (${status})${detail ? `: ${detail}` : ''}`,
		operation,
		status,
		detail,
	}),
});
export type ClientError = InferErrors<typeof ClientError>;

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
 * Build a typed Epicenter client bound to a base URL, an authed fetch, and the
 * signed-in `ownerId`. Every surface is synchronous to construct and addresses
 * routes under that owner; nothing here touches `/api/session`.
 */
export function createEpicenterClient(opts: EpicenterClientOptions) {
	const base = opts.baseURL.replace(/\/+$/, '');
	const { ownerId } = opts;

	const assets = {
		async upload(
			file: File,
			params: { visibility?: AssetVisibility } = {},
		): Promise<UploadAssetResponse> {
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
			const res = await opts.fetch(API_ROUTES.assets.list.url(base, ownerId));
			if (!res.ok) {
				throw new Error(`epicenter.assets.list: ${res.status}`);
			}
			return (await res.json()) as AssetRow[];
		},

		async usage(): Promise<{ totalBytes: number }> {
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
			const res = await opts.fetch(
				API_ROUTES.assets.byId.url(base, ownerId, id),
				{ method: 'DELETE' },
			);
			if (!res.ok) {
				throw new Error(`epicenter.assets.delete: ${res.status}`);
			}
		},

		/**
		 * Build the full URL for an asset. Sync; the owner partition is the one the
		 * client was constructed with.
		 *
		 * Useful for embedding in Yjs documents, `<img src>`, share buttons.
		 */
		url(id: string): string {
			return API_ROUTES.assets.byId.url(base, ownerId, id);
		},
	};

	// Run one authed request, folding transport failure and non-2xx into a typed
	// Result so the blob methods never throw.
	async function request(
		input: string,
		init: RequestInit | undefined,
		operation: string,
	): Promise<Result<Response, ClientError>> {
		const { data: res, error } = await tryAsync({
			try: () => opts.fetch(input, init),
			catch: (cause) => ClientError.TransportFailed({ operation, cause }),
		});
		if (error !== null) return Err(error);
		if (!res.ok) {
			const detail = (await res.text().catch(() => '')).slice(0, 200);
			return ClientError.RequestFailed({ operation, status: res.status, detail });
		}
		return Ok(res);
	}

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
		): Promise<Result<AddBlobResult, ClientError>> {
			let bytes: ArrayBuffer;
			let contentType: string;
			if (typeof fileOrUrl === 'string') {
				const { data: source, error } = await tryAsync({
					try: () => fetch(fileOrUrl),
					catch: (cause) =>
						ClientError.TransportFailed({ operation: `GET ${fileOrUrl}`, cause }),
				});
				if (error !== null) return Err(error);
				if (!source.ok) {
					return ClientError.RequestFailed({
						operation: `GET ${fileOrUrl}`,
						status: source.status,
					});
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

			const { data: ticketRes, error: ticketError } = await request(
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
				'POST /blobs',
			);
			if (ticketError !== null) return Err(ticketError);
			const ticket = (await ticketRes.json()) as BlobTicket;

			if (ticket.status === 'duplicate') {
				return Ok({ sha256, url: ticket.url, duplicate: true });
			}

			const { data: put, error: putError } = await tryAsync({
				try: () =>
					fetch(ticket.uploadUrl, {
						method: 'PUT',
						headers: ticket.requiredHeaders,
						body: bytes,
					}),
				catch: (cause) =>
					ClientError.TransportFailed({ operation: 'store PUT', cause }),
			});
			if (putError !== null) return Err(putError);
			if (!put.ok) {
				const detail = (await put.text().catch(() => '')).slice(0, 200);
				return ClientError.RequestFailed({
					operation: 'store PUT',
					status: put.status,
					detail,
				});
			}
			return Ok({ sha256, url: ticket.url, duplicate: false });
		},

		/**
		 * Build the content-addressed read URL for a blob. Sync and owner-explicit
		 * (unlike `assets.url`, which is bound to the construction owner): a blob is
		 * referenced from a vault receipt that already records its owner, so this
		 * can address any owner partition, not just the signed-in one.
		 */
		url(ownerId: OwnerId, sha256: string): string {
			return API_ROUTES.blobs.byHash.url(base, ownerId, sha256);
		},

		/**
		 * Read a blob's bytes. The server answers 302 to a short-lived presigned
		 * GET; `fetch` follows it, and the cross-origin redirect drops the bearer
		 * so the presigned URL is hit clean. On success `data` is the bytes
		 * `Response`.
		 */
		async get(sha256: string): Promise<Result<Response, ClientError>> {
			return request(
				API_ROUTES.blobs.byHash.url(base, ownerId, sha256),
				undefined,
				'GET /blobs/:sha256',
			);
		},

		async list(): Promise<Result<BlobRow[], ClientError>> {
			const { data: res, error: reqError } = await request(
				API_ROUTES.blobs.list.url(base, ownerId),
				undefined,
				'GET /blobs',
			);
			if (reqError !== null) return Err(reqError);
			return Ok((await res.json()) as BlobRow[]);
		},

		async usage(): Promise<Result<BlobUsage, ClientError>> {
			const { data: res, error: reqError } = await request(
				API_ROUTES.blobs.usage.url(base, ownerId),
				undefined,
				'GET /blobs/usage',
			);
			if (reqError !== null) return Err(reqError);
			return Ok((await res.json()) as BlobUsage);
		},

		async delete(sha256: string): Promise<Result<void, ClientError>> {
			const { error: reqError } = await request(
				API_ROUTES.blobs.byHash.url(base, ownerId, sha256),
				{ method: 'DELETE' },
				'DELETE /blobs/:sha256',
			);
			if (reqError !== null) return Err(reqError);
			return Ok(undefined);
		},
	};

	return {
		assets,
		blobs,
	};
}

export type EpicenterClient = ReturnType<typeof createEpicenterClient>;
