/**
 * `epicenter blobs`: archive vault files in the content-addressed cloud store
 * and restore them, lockfile-style.
 *
 * The committed record is one lockfile, `epicenter.blobs.lock` at the Epicenter
 * root, mapping each gitignored vault file to its content address. The binaries
 * stay out of git; `blobs pull` re-downloads any that are missing. This is to
 * heavy media what a lockfile is to dependencies. The root is the folder holding
 * `epicenter.config.ts`, found by walking up (or `-C <dir>`), like every other
 * command.
 *
 *   add <file|url>  upload the bytes (hash -> ticket -> presigned PUT straight
 *                   to the store) and upsert the manifest entry
 *   ls              list the owner's stored blobs (the store is the index)
 *   get <sha256>    download one blob by content address to a file
 *   rm  <sha256>    delete one blob from the store (cloud only)
 *   pull            restore missing manifest files from their content address
 *
 * Every subcommand is a direct cloud round-trip built from the machine-auth
 * session; none route through the local daemon, unlike `run`. See
 * `specs/20260623T220000-content-addressed-blob-store.md`.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as machineAuth from '@epicenter/auth/node';
import { createEpicenterClient, type EpicenterClient } from '@epicenter/client';
import mime from 'mime';
import { extractErrorMessage } from 'wellcrafted/error';
import { Err, Ok, type Result, tryAsync } from 'wellcrafted/result';
import { cmd } from '../util/cmd.js';
import { epicenterRootOption } from '../util/common-options.js';
import { fail, formatOptions, output } from '../util/format-output.js';
import {
	type BlobManifest,
	downloadName,
	emptyManifest,
	parseManifest,
	stringifyManifest,
	upsertManifestEntry,
} from './blobs-manifest.js';

/** A source is fetched when it looks like an http(s) URL, else read from disk. */
const HTTP_URL = /^https?:\/\//i;

/** The committed manifest: a lockfile at the Epicenter root, beside
 * `epicenter.config.ts` (NOT under the gitignored `.epicenter/` machine-state
 * dir, so it can be committed). Shares the `epicenter.*` prefix with the config. */
const MANIFEST_FILENAME = 'epicenter.blobs.lock';

const addCommand = cmd({
	command: 'add <source>',
	describe: 'Archive a vault file or http(s) URL and record it in the manifest',
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
			.option('C', epicenterRootOption)
			.option('dir', {
				type: 'string',
				describe:
					'Directory a URL download lands in (default: the Epicenter root). A local file is recorded in place.',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenterRoot = argv.C;
		const epicenter = await connectCloud();
		if (!epicenter) return;

		// Hold the bytes locally so we can write the download and hand the SDK a
		// Blob (no second fetch of a URL we already downloaded).
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

		// Where the binary lives in the vault: a local file is recorded in place;
		// a URL download is written into --dir (default the Epicenter root), named
		// by content address so an untrusted URL segment never becomes a filename.
		const blobPath = localPath
			? localPath
			: path.resolve(
					argv.dir ?? epicenterRoot,
					downloadName({ sha256: result.sha256, contentType }),
				);

		// The manifest key is the blob's path relative to the Epicenter root, so it
		// must sit inside the root for the key to be a clean relative path that
		// `pull` can restore to.
		const key = path.relative(epicenterRoot, blobPath);
		if (key.startsWith('..') || path.isAbsolute(key)) {
			fail(
				`'${rel(blobPath)}' is outside the Epicenter root '${rel(epicenterRoot) || '.'}'; pass -C to set the root`,
			);
			return;
		}

		// Write the bytes only when they are not already on disk (a URL download,
		// or a copy into a different --dir); a local file added in place exists.
		if (!(await pathExists(blobPath))) {
			await fs.mkdir(path.dirname(blobPath), { recursive: true });
			await fs.writeFile(blobPath, bytes);
		}

		// The manifest sits at the Epicenter root, which already exists (we found
		// `epicenter.config.ts` there), so this is a plain write, no mkdir.
		const manifestPath = path.join(epicenterRoot, MANIFEST_FILENAME);
		const manifest = await loadManifest(manifestPath);
		const next = upsertManifestEntry(manifest, toPosix(key), {
			sha256: result.sha256,
			size_bytes: bytes.byteLength,
			content_type: contentType,
			...(sourceUrl ? { source_url: sourceUrl } : {}),
			archived_at: new Date().toISOString(),
		});
		await fs.writeFile(manifestPath, stringifyManifest(next));

		output(
			{
				sha256: result.sha256,
				url: result.url,
				duplicate: result.duplicate,
				path: rel(blobPath),
				manifest: rel(manifestPath),
			},
			{ format: argv.format },
		);
	},
});

const lsCommand = cmd({
	command: 'ls',
	describe:
		"List the owner's stored blobs (content address, size, upload time)",
	builder: (yargs) => yargs.options(formatOptions).strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: blobs, error } = await epicenter.blobs.list();
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output(blobs, { format: argv.format });
	},
});

const rmCommand = cmd({
	command: 'rm <sha256>',
	// Removes the cloud object only; any local file and its manifest entry are
	// left untouched (the store is content-addressed, the disk is yours to manage).
	describe: 'Delete a blob from the store by content address (idempotent)',
	builder: (yargs) =>
		yargs
			.positional('sha256', {
				type: 'string',
				demandOption: true,
				describe: 'The lowercase-hex sha256 content address',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { error } = await epicenter.blobs.delete(argv.sha256);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}
		output({ sha256: argv.sha256, deleted: true }, { format: argv.format });
	},
});

const getCommand = cmd({
	command: 'get <sha256>',
	describe: 'Download a blob by content address and write it to a file',
	builder: (yargs) =>
		yargs
			.positional('sha256', {
				type: 'string',
				demandOption: true,
				describe: 'The lowercase-hex sha256 content address',
			})
			.option('output', {
				alias: 'o',
				type: 'string',
				describe: 'Destination path (default: <sha256>.<ext> in the cwd)',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenter = await connectCloud();
		if (!epicenter) return;

		const { data: res, error } = await epicenter.blobs.get(argv.sha256);
		if (error !== null) {
			fail(error.message, { code: 2 });
			return;
		}

		// Content type rides on the stored object (pinned at upload), so it names
		// the extension when the caller did not pick an output path.
		const contentType =
			res.headers.get('content-type') ?? 'application/octet-stream';
		const bytes = Buffer.from(await res.arrayBuffer());
		const ext = mime.getExtension(contentType);
		const outputPath = path.resolve(
			argv.output ?? (ext ? `${argv.sha256}.${ext}` : argv.sha256),
		);
		await fs.mkdir(path.dirname(outputPath), { recursive: true });
		await fs.writeFile(outputPath, bytes);

		output(
			{
				sha256: argv.sha256,
				output: rel(outputPath),
				size_bytes: bytes.byteLength,
				content_type: contentType,
			},
			{ format: argv.format },
		);
	},
});

const pullCommand = cmd({
	command: 'pull',
	describe: 'Restore missing vault files from the manifest by content address',
	builder: (yargs) =>
		yargs
			.option('C', epicenterRootOption)
			.option('force', {
				type: 'boolean',
				default: false,
				describe: 'Re-download even files already present on disk',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		const epicenterRoot = argv.C;
		const manifestPath = path.join(epicenterRoot, MANIFEST_FILENAME);
		const manifest = await loadManifest(manifestPath);
		const entries = Object.entries(manifest.blobs);
		if (entries.length === 0) {
			fail(`no blobs recorded in ${rel(manifestPath)}`);
			return;
		}

		const epicenter = await connectCloud();
		if (!epicenter) return;

		// Serial on purpose: restores are bandwidth-bound, and one row per file
		// keeps the report legible.
		const results: Record<string, unknown>[] = [];
		for (const [relPath, entry] of entries) {
			const dest = path.resolve(epicenterRoot, relPath);
			if (!argv.force && (await pathExists(dest))) {
				results.push({ path: relPath, status: 'present' });
				continue;
			}

			const { data: res, error } = await epicenter.blobs.get(entry.sha256);
			if (error !== null) {
				results.push({ path: relPath, status: 'failed', error: error.message });
				continue;
			}
			const bytes = Buffer.from(await res.arrayBuffer());

			// The store enforces the hash on write, but a download can still be
			// truncated mid-flight; verify before we trust the bytes on disk.
			const actual = sha256Of(bytes);
			if (actual !== entry.sha256) {
				results.push({
					path: relPath,
					status: 'corrupt',
					expected: entry.sha256,
					actual,
				});
				continue;
			}

			await fs.mkdir(path.dirname(dest), { recursive: true });
			await fs.writeFile(dest, bytes);
			results.push({
				path: relPath,
				status: 'restored',
				size_bytes: bytes.byteLength,
			});
		}

		output(results, { format: argv.format });
	},
});

export const blobsCommand = cmd({
	command: 'blobs <subcommand>',
	describe: 'Archive and retrieve bytes in the content-addressed blob store',
	builder: (yargs) =>
		yargs
			.command(addCommand)
			.command(lsCommand)
			.command(getCommand)
			.command(rmCommand)
			.command(pullCommand)
			.demandCommand(1, 'Specify a subcommand: add, ls, get, rm, pull'),
	handler: () => {},
});

/**
 * Build the owner-scoped cloud client from the persisted machine-auth session,
 * or print a ready-to-read failure and return `null`. Every `blobs` subcommand
 * is a direct cloud round-trip (no daemon), so each one starts here. Identity
 * comes off `auth.state`; the client is owner-scoped and never resolves
 * `/api/session` itself.
 */
async function connectCloud(): Promise<EpicenterClient | null> {
	const { data: auth, error: authError } =
		await machineAuth.createMachineAuthClient();
	if (authError) {
		fail(authError.message);
		return null;
	}
	if (auth.state.status === 'signed-out') {
		fail('not signed in: run `epicenter auth login` first');
		return null;
	}
	return createEpicenterClient({
		baseURL: auth.baseURL,
		fetch: (input, init) => auth.fetch(input, init),
		ownerId: auth.state.ownerId,
	});
}

/** Bytes plus the metadata the manifest entry and on-disk copy need. */
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
			contentTypeOverride ??
			mime.getType(localPath) ??
			'application/octet-stream',
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

/** Read the manifest at `manifestPath`, or the empty manifest if it is absent. */
async function loadManifest(manifestPath: string): Promise<BlobManifest> {
	if (!(await pathExists(manifestPath))) return emptyManifest();
	return parseManifest(await fs.readFile(manifestPath, 'utf8'));
}

/** Lowercase-hex sha256 of bytes, to verify a download against its address. */
function sha256Of(bytes: Buffer): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** A path relative to the cwd, for terse output. */
function rel(p: string): string {
	return path.relative(process.cwd(), p);
}

/** A manifest key is always POSIX-separated, regardless of the host platform. */
function toPosix(p: string): string {
	return p.split(path.sep).join('/');
}
