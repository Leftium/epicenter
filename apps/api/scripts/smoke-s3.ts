/**
 * Zero-dependency, in-memory S3 stand-in for LOCAL blob smoke tests only.
 *
 * The content-addressed blob store (`packages/server/src/s3-blob-store.ts`)
 * talks plain S3-over-HTTPS (presigned PUT/GET, HEAD, ListObjectsV2, DELETE).
 * Running it for real needs an S3-compatible endpoint — R2, MinIO, or Garage.
 * When you do not want to stand up a container just to smoke the blob control
 * plane, point `BLOBS_S3_ENDPOINT` at this process instead:
 *
 *   bun apps/api/scripts/smoke-s3.ts            # listens on :9000
 *   BLOBS_S3_ENDPOINT=http://localhost:9000 \
 *   BLOBS_S3_ACCESS_KEY_ID=x BLOBS_S3_SECRET_ACCESS_KEY=x \
 *   BLOBS_S3_BUCKET=epicenter-blobs ... bun apps/api/server.ts
 *
 * It deliberately does NOT verify SigV4 signatures or the x-amz-checksum-sha256
 * header — it trusts the caller, because the only caller is your own smoke run.
 * That makes it a stand-in for the store's HTTP shape, not a security-faithful
 * S3. Use a real MinIO/Garage/R2 for anything that must enforce the checksum.
 */

const PORT = Number(process.env.PORT ?? 9000);
const store = new Map<string, { bytes: Uint8Array; uploaded: string }>();

function xmlEscape(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Build a ListObjectsV2 XML body for the keys under `prefix`. */
function listXml(bucket: string, prefix: string): string {
	const contents = [...store.entries()]
		.filter(([key]) => key.startsWith(prefix))
		.map(
			([key, obj]) =>
				`<Contents><Key>${xmlEscape(key)}</Key><Size>${obj.bytes.byteLength}</Size><LastModified>${obj.uploaded}</LastModified></Contents>`,
		)
		.join('');
	return `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xmlEscape(prefix)}</Prefix><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`;
}

Bun.serve({
	port: PORT,
	async fetch(req) {
		const url = new URL(req.url);
		// Path is /<bucket>/<key...>; a bare /<bucket>?list-type=2 is a LIST.
		const segments = url.pathname.replace(/^\/+/, '').split('/');
		const bucket = segments[0] ?? '';
		const key = segments.slice(1).join('/');

		if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
			const prefix = url.searchParams.get('prefix') ?? '';
			return new Response(listXml(bucket, prefix), {
				headers: { 'content-type': 'application/xml' },
			});
		}

		if (req.method === 'PUT') {
			const bytes = new Uint8Array(await req.arrayBuffer());
			store.set(key, { bytes, uploaded: new Date().toISOString() });
			return new Response(null, { status: 200 });
		}

		if (req.method === 'HEAD') {
			return new Response(null, { status: store.has(key) ? 200 : 404 });
		}

		if (req.method === 'GET') {
			const obj = store.get(key);
			if (!obj) return new Response('Not Found', { status: 404 });
			return new Response(obj.bytes as BlobPart, { status: 200 });
		}

		if (req.method === 'DELETE') {
			store.delete(key);
			return new Response(null, { status: 204 });
		}

		return new Response('Method Not Allowed', { status: 405 });
	},
});

console.log(
	`smoke-s3 (in-memory S3 stand-in) listening on http://localhost:${PORT}`,
);
