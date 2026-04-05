import type { FileId } from './ids.js';

const ID_SCHEME = 'id:';

/**
 * Check whether a link href uses the internal `id:` scheme.
 *
 * Internal links reference other files in the workspace by their FileId,
 * using the format `id:{GUID}`. This is the discriminator for distinguishing
 * internal links from external URLs.
 *
 * @example
 * ```typescript
 * isInternalLink('id:01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b'); // true
 * isInternalLink('https://example.com'); // false
 * isInternalLink(''); // false
 * ```
 */
export function isInternalLink(href: string): boolean {
	return href.startsWith(ID_SCHEME);
}

/**
 * Extract the target FileId from an internal link href.
 *
 * Assumes the href has already been validated with {@link isInternalLink}.
 * Strips the `id:` prefix and returns the remaining string as a branded FileId.
 *
 * @example
 * ```typescript
 * const fileId = getTargetFileId('id:01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b');
 * // fileId === '01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b' as FileId
 * ```
 */
export function getTargetFileId(href: string): FileId {
	return href.slice(ID_SCHEME.length) as FileId;
}

/**
 * Build an internal link href from a FileId.
 *
 * Produces the `id:{GUID}` format used in markdown link targets
 * (e.g., `[File Name](id:GUID)`). This is the inverse of {@link getTargetFileId}.
 *
 * @example
 * ```typescript
 * const href = makeInternalHref('01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b' as FileId);
 * // href === 'id:01965a3b-7e2d-7f8a-b3c1-9a4e5f6d7c8b'
 * ```
 */
export function makeInternalHref(fileId: FileId): string {
	return `${ID_SCHEME}${fileId}`;
}
