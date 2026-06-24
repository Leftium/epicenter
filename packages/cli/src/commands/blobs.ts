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
import mime from 'mime';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { cmd } from '../util/cmd.js';
import { fail, formatOptions, output } from '../util/format-output.js';
import {
	type BlobReceipt,
	toReceiptMarkdown,
	workingCopyName,
} from './blobs-receipt.js';

/** A source is fetched when it looks like an http(s) URL, else read from disk. */
const HTTP_URL = /^https?:\/\//i;

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
		if (auth.state.status === 'signed-out') {
			fail('not signed in: run `epicenter auth login` first');
			return;
		}
		// Identity comes off auth.state; the client is owner-scoped and never
		// resolves `/api/session` itself.
		const { ownerId } = auth.state;
		const epicenter = createEpicenterClient({
			baseURL: auth.baseURL,
			fetch: (input, init) => auth.fetch(input, init),
			ownerId,
		});

		// Hold the bytes locally so we can write the working copy and hand the SDK
		// a Blob (no second fetch of a URL we already downloaded).
		const { data: resolved, error: resolveError } = await resolveSource(
			argv.source,
			argv.contentType,
		);
		if (resolveError !== null) {
			fail(resolveError);
			return;
		}
		const { bytes, contentType, sourceUrl, localPath } = resolved;

		const { data: result, error: uploadError } = await epicenter.blobs.add(
			new Blob([new Uint8Array(bytes)], { type: contentType }),
			{ contentType },
		);
		if (uploadError !== null) {
			fail(uploadError.message, { code: 2 });
			return;
		}

		const name = workingCopyName({
			localPath,
			sha256: result.sha256,
			contentType,
		});
		const dir = argv.dir
			? path.resolve(argv.dir)
			: localPath
				? path.dirname(localPath)
				: process.cwd();
		await fs.mkdir(dir, { recursive: true });
		const workingCopyPath = path.join(dir, name);
		const receiptPath = path.join(dir, `${name}.md`);

		// A local file added in place is already its own working copy; a URL
		// download (or a copy into a different --dir) is written out.
		const wroteWorkingCopy = !(await pathExists(workingCopyPath));
		if (wroteWorkingCopy) await fs.writeFile(workingCopyPath, bytes);

		// Never clobber an existing receipt: a re-add must not lose hand edits to
		// the note body.
		const wroteReceipt = !(await pathExists(receiptPath));
		if (wroteReceipt) {
			const receipt: BlobReceipt = {
				sha256: result.sha256,
				source_url: sourceUrl,
				size_bytes: bytes.byteLength,
				content_type: contentType,
				location: {
					provider: 'epicenter',
					owner: ownerId,
					key: `owners/${ownerId}/blobs/${result.sha256}`,
				},
				encryption: 'none',
				archived_at: new Date().toISOString(),
			};
			await fs.writeFile(receiptPath, toReceiptMarkdown(receipt, name));
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
	/** Absolute path when the source was a local file. */
	localPath?: string;
};

/**
 * Read a source into bytes. An http(s) URL is downloaded (content type from the
 * response); a local path is read (content type inferred from the extension via
 * `mime`). The error channel is a ready-to-print message so the handler has one
 * failure path.
 */
async function resolveSource(
	source: string,
	contentTypeOverride: string | undefined,
): Promise<Result<ResolvedSource, string>> {
	if (HTTP_URL.test(source)) {
		const { data: res, error } = await tryAsync({
			try: () => fetch(source),
			catch: (cause) =>
				Err(`could not fetch ${source}: ${extractErrorMessage(cause)}`),
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
		});
	}

	const localPath = path.resolve(source);
	const { data: bytes, error } = await tryAsync({
		try: () => fs.readFile(localPath),
		catch: (cause) =>
			Err(`could not read ${source}: ${extractErrorMessage(cause)}`),
	});
	if (error !== null) return Err(error);
	return Ok({
		bytes,
		contentType:
			contentTypeOverride ?? mime.getType(localPath) ?? 'application/octet-stream',
		localPath,
	});
}

async function pathExists(p: string): Promise<boolean> {
	try {
		await fs.access(p);
		return true;
	} catch {
		return false;
	}
}
