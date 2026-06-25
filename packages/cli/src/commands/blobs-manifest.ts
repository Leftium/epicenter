/**
 * Pure helpers for the vault blob manifest, split out so they can be unit-tested
 * without a network or a filesystem.
 *
 * The manifest (`epicenter.blobs.lock`, committed at the Epicenter root beside
 * `epicenter.config.ts`) is the record of which gitignored vault files are
 * archived in the content-addressed store. It is to heavy media what a lockfile
 * is to dependencies: the small thing you commit, while the binaries it points
 * at stay out of git and are restored from their content address by `epicenter
 * blobs pull`. Keys are POSIX paths relative to the Epicenter root; the sha256
 * IS the integrity hash. Replaces the per-blob `.md` receipt; see
 * `specs/20260623T220000-content-addressed-blob-store.md`.
 */

import mime from 'mime';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/** One archived file, keyed in the manifest by its vault-relative POSIX path. */
export type BlobManifestEntry = {
	sha256: string;
	size_bytes: number;
	content_type: string;
	/** Set only when the bytes came from an http(s) URL. */
	source_url?: string;
	archived_at: string;
};

/** The whole manifest: a path -> entry map under a `blobs` key so the top level
 * stays open to sibling fields later without re-keying. */
export type BlobManifest = { blobs: Record<string, BlobManifestEntry> };

/** The empty manifest, returned for a missing or blank lockfile. */
export function emptyManifest(): BlobManifest {
	return { blobs: {} };
}

/**
 * Parse a manifest from its on-disk YAML. A missing/blank file or a doc with no
 * `blobs` map reads as empty; we wrote this file, so the coercion is light, not
 * a full validation pass.
 */
export function parseManifest(text: string): BlobManifest {
	const doc = parseYaml(text) as { blobs?: Record<string, BlobManifestEntry> };
	return { blobs: doc?.blobs ?? {} };
}

/**
 * Serialize a manifest to deterministic YAML so the committed lockfile diffs
 * cleanly: paths sorted, and each entry's fields emitted in a fixed order
 * (`source_url` omitted when absent).
 */
export function stringifyManifest(manifest: BlobManifest): string {
	const blobs: Record<string, BlobManifestEntry> = {};
	for (const path of Object.keys(manifest.blobs).sort()) {
		const entry = manifest.blobs[path];
		if (!entry) continue;
		blobs[path] = {
			sha256: entry.sha256,
			size_bytes: entry.size_bytes,
			content_type: entry.content_type,
			...(entry.source_url ? { source_url: entry.source_url } : {}),
			archived_at: entry.archived_at,
		};
	}
	return stringifyYaml({ blobs });
}

/** Upsert one entry by vault-relative path, returning a new manifest. */
export function upsertManifestEntry(
	manifest: BlobManifest,
	path: string,
	entry: BlobManifestEntry,
): BlobManifest {
	return { blobs: { ...manifest.blobs, [path]: entry } };
}

/**
 * Name the on-disk file for a URL download: content address + extension, so an
 * untrusted URL segment never becomes a filename (no path traversal, control
 * characters, or decode crash). A local file is recorded in place and never
 * needs a name; the store key is content-addressed regardless.
 */
export function downloadName(args: {
	sha256: string;
	contentType: string;
}): string {
	const ext = mime.getExtension(args.contentType);
	return ext ? `${args.sha256}.${ext}` : args.sha256;
}
