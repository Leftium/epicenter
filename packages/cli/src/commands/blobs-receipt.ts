/**
 * Pure receipt + naming helpers for `epicenter blobs add`, split out so they can
 * be unit-tested without a network or a filesystem.
 */

import { basename } from 'node:path';
import mime from 'mime';
import { stringify as stringifyYaml } from 'yaml';

/**
 * The vault receipt frontmatter, before serialization. Snake_case keys are the
 * on-disk wire shape; `yaml` reads them straight off this object. `source_url`
 * is omitted from the output when undefined (a local file has no source URL).
 * Mirrors `specs/20260623T220000-content-addressed-blob-store.md`.
 */
export type BlobReceipt = {
	sha256: string;
	source_url?: string;
	size_bytes: number;
	content_type: string;
	location: { provider: 'epicenter'; owner: string; key: string };
	encryption: 'none';
	archived_at: string;
};

/**
 * Build the vault receipt: YAML frontmatter (serialized by the `yaml` package,
 * so the nested `location` map and any special characters in `source_url` are
 * correct by construction) plus a body that links the local working copy.
 */
export function toReceiptMarkdown(
	receipt: BlobReceipt,
	workingCopy: string,
): string {
	const frontmatter = stringifyYaml(receipt).trimEnd();
	return `---\n${frontmatter}\n---\n\n[${workingCopy}](${encodeURI(workingCopy)})\n`;
}

/**
 * Name the local working copy. A local file keeps its own (trusted) basename; a
 * URL download is named by content address + extension, so an untrusted URL
 * segment never becomes a filename (no path traversal, control characters, or
 * decode crash). The store key is content-addressed regardless; this only
 * governs the convenience copy on disk.
 */
export function workingCopyName(args: {
	localPath?: string;
	sha256: string;
	contentType: string;
}): string {
	if (args.localPath) return basename(args.localPath);
	const ext = mime.getExtension(args.contentType);
	return ext ? `${args.sha256}.${ext}` : args.sha256;
}
