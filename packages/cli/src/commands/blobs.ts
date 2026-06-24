/**
 * `epicenter blobs`: archive bytes into the content-addressed cloud blob store.
 *
 * `blobs add <url|file>` resolves the bytes (an http(s) URL is downloaded; a
 * local path is read), uploads them through `client.blobs.add` (hash -> ticket
 * -> presigned PUT straight to the store), then writes a vault receipt beside a
 * local working copy. This is a cloud round-trip built from the machine auth
 * session; it deliberately does NOT route through the local daemon, unlike
 * `run`. See `specs/20260623T220000-content-addressed-blob-store.md`.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as machineAuth from '@epicenter/auth/node';
import { createEpicenterClient } from '@epicenter/client';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { cmd } from '../util/cmd.js';
import { fail, formatOptions, output } from '../util/format-output.js';

/** A source is fetched when it looks like an http(s) URL, else read from disk. */
const HTTP_URL = /^https?:\/\//i;

/** Minimal extension -> MIME map for inferring a local file's content type. */
const MIME_BY_EXT: Record<string, string> = {
	'.mp4': 'video/mp4',
	'.mov': 'video/quicktime',
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.m4a': 'audio/mp4',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.pdf': 'application/pdf',
	'.txt': 'text/plain',
	'.md': 'text/markdown',
	'.json': 'application/json',
};

const addCommand = cmd({
	command: 'add <source>',
	describe: 'Archive a local file or http(s) URL into the blob store',
	builder: (yargs) =>
		yargs
			.positional('source', {
				type: 'string',
				demandOption: true,
				describe: 'A local file path or an http(s) URL',
			})
			.option('content-type', {
				type: 'string',
				describe: 'Override the content type (else inferred from the source)',
			})
			.option('dir', {
				type: 'string',
				describe:
					"Directory for the receipt + working copy (default: the file's directory, or cwd for a URL)",
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		// Build the cloud client from the persisted machine auth session. No
		// daemon: blob bytes are a direct cloud round-trip.
		const { data: auth, error: authError } =
			await machineAuth.createMachineAuthClient();
		if (authError) {
			fail(authError.message);
			return;
		}
		const epicenter = createEpicenterClient({
			baseURL: auth.baseURL,
			fetch: (input, init) => auth.fetch(input, init),
		});

		// Resolve bytes, content type, and a base filename up front, so we hold the
		// bytes for the working copy and hand the SDK a Blob (no second fetch).
		const { data: resolved, error: resolveError } = await resolveSource(
			argv.source,
			argv.contentType,
		);
		if (resolveError !== null) {
			fail(resolveError);
			return;
		}
		const { bytes, contentType, sourceUrl, basename, localPath } = resolved;

		const { data: result, error: uploadError } = await tryAsync({
			try: () =>
				epicenter.blobs.add(new Blob([new Uint8Array(bytes)], { type: contentType }), {
					contentType,
				}),
			catch: (cause) => Err(`upload failed: ${extractErrorMessage(cause)}`),
		});
		if (uploadError !== null) {
			fail(uploadError, { code: 2 });
			return;
		}

		// The receipt records the owner partition; reuse the session the upload
		// already resolved and cached.
		const { ownerId } = await epicenter.session.current();

		const dir = argv.dir
			? path.resolve(argv.dir)
			: localPath
				? path.dirname(localPath)
				: process.cwd();
		await fs.mkdir(dir, { recursive: true });
		const workingCopyPath = path.join(dir, basename);
		const receiptPath = path.join(dir, `${basename}.md`);

		// A local file added in place is already its own working copy; a URL
		// download (or a copy into a different --dir) is written out.
		const wroteWorkingCopy = !(await pathExists(workingCopyPath));
		if (wroteWorkingCopy) await fs.writeFile(workingCopyPath, bytes);

		// Never clobber an existing receipt: a re-add must not lose hand edits to
		// the note body.
		const wroteReceipt = !(await pathExists(receiptPath));
		if (wroteReceipt) {
			await fs.writeFile(
				receiptPath,
				toReceiptMarkdown(
					{
						sha256: result.sha256,
						sourceUrl,
						sizeBytes: bytes.byteLength,
						contentType,
						ownerId,
						key: `owners/${ownerId}/blobs/${result.sha256}`,
						archivedAt: new Date().toISOString(),
					},
					basename,
				),
			);
		}

		output(
			{
				sha256: result.sha256,
				url: result.url,
				duplicate: result.duplicate,
				receipt: wroteReceipt ? path.relative(process.cwd(), receiptPath) : null,
				workingCopy: path.relative(process.cwd(), workingCopyPath),
			},
			{ format: argv.format },
		);
	},
});

export const blobsCommand = cmd({
	command: 'blobs <subcommand>',
	describe: 'Archive bytes into the content-addressed blob store',
	builder: (yargs) =>
		yargs.command(addCommand).demandCommand(1, 'Specify a subcommand: add'),
	handler: () => {},
});

/** Bytes plus the metadata the receipt and working copy need. */
type ResolvedSource = {
	bytes: Buffer;
	contentType: string;
	/** Set only when the source was an http(s) URL. */
	sourceUrl?: string;
	basename: string;
	/** Absolute path when the source was a local file. */
	localPath?: string;
};

/**
 * Read a source into bytes. An http(s) URL is downloaded (content type from the
 * response); a local path is read (content type inferred from the extension).
 * The error channel is a ready-to-print message so the handler has one failure
 * path.
 */
async function resolveSource(
	source: string,
	contentTypeOverride: string | undefined,
): Promise<Result<ResolvedSource, string>> {
	if (HTTP_URL.test(source)) {
		const { data: res, error } = await tryAsync({
			try: () => fetch(source),
			catch: (cause) => Err(`could not fetch ${source}: ${extractErrorMessage(cause)}`),
		});
		if (error !== null) return Err(error);
		if (!res.ok) return Err(`could not fetch ${source}: ${res.status}`);
		const bytes = Buffer.from(await res.arrayBuffer());
		return Ok({
			bytes,
			contentType:
				contentTypeOverride ??
				res.headers.get('content-type') ??
				'application/octet-stream',
			sourceUrl: source,
			basename: basenameFromUrl(source),
		});
	}

	const localPath = path.resolve(source);
	const { data: bytes, error } = await tryAsync({
		try: () => fs.readFile(localPath),
		catch: (cause) => Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	return Ok({
		bytes,
		contentType:
			contentTypeOverride ??
			MIME_BY_EXT[path.extname(localPath).toLowerCase()] ??
			'application/octet-stream',
		basename: path.basename(localPath),
		localPath,
	});
}

/**
 * Derive a safe filename from a URL's last path segment, or `blob`. One
 * try/catch wraps both the URL parse and `decodeURIComponent` (which throws on a
 * malformed `%`), so any failure falls back to `blob`.
 */
function basenameFromUrl(url: string): string {
	try {
		const last = new URL(url).pathname.split('/').filter(Boolean).pop();
		if (!last) return 'blob';
		// Drop control chars, DEL, and path separators (codes 0x2f and 0x5c),
		// keeping the extension's dot. Mirrors assets.ts sanitizeFilename.
		const cleaned = Array.from(decodeURIComponent(last))
			.filter((ch) => {
				const code = ch.charCodeAt(0);
				return code > 0x1f && code !== 0x7f && code !== 0x2f && code !== 0x5c;
			})
			.join('')
			.trim();
		return cleaned || 'blob';
	} catch {
		return 'blob';
	}
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}

/**
 * Render the vault receipt: markdown frontmatter (matter's source of truth)
 * plus a body that links the local working copy. Mirrors the receipt shape in
 * `specs/20260623T220000-content-addressed-blob-store.md`. The `location.key`
 * mirrors `@epicenter/server`'s `blobKey`; the server package is too heavy to
 * import into the CLI just for one durable string.
 */
function toReceiptMarkdown(
	r: {
		sha256: string;
		sourceUrl?: string;
		sizeBytes: number;
		contentType: string;
		ownerId: string;
		key: string;
		archivedAt: string;
	},
	workingCopy: string,
): string {
	const lines = ['---', `sha256: ${r.sha256}`];
	if (r.sourceUrl) lines.push(`source_url: ${yamlString(r.sourceUrl)}`);
	lines.push(
		`size_bytes: ${r.sizeBytes}`,
		`content_type: ${yamlString(r.contentType)}`,
		'location:',
		'  provider: epicenter',
		`  owner: ${yamlString(r.ownerId)}`,
		`  key: ${yamlString(r.key)}`,
		'encryption: none',
		`archived_at: ${yamlString(r.archivedAt)}`,
		'---',
		'',
		`[${workingCopy}](${encodeURI(workingCopy)})`,
		'',
	);
	return lines.join('\n');
}

/** A double-quoted YAML scalar: always valid regardless of `:`/`#`/quotes. */
function yamlString(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
