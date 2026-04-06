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

/** Regex matching `[display text](id:GUID)` markdown links. */
const INTERNAL_LINK_RE = /\[([^\]]+)\]\(id:[^)]+\)/g;

/** Regex matching `[[Page Name]]` wikilinks. */
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Convert internal `id:` markdown links to `[[wikilink]]` syntax.
 *
 * Used by the markdown materializer when exporting workspace content to `.md`
 * files. This keeps the exported files readable in wikilink-aware editors
 * while preserving the original display text from the internal link.
 * Non-internal links such as `https://` URLs are left untouched.
 *
 * @example
 * ```typescript
 * const body = 'See [Meeting Notes](id:abc-123) for details.';
 *
 * convertInternalLinksToWikilinks(body);
 * // 'See [[Meeting Notes]] for details.'
 * ```
 */
export function convertInternalLinksToWikilinks(body: string): string {
	return body.replace(INTERNAL_LINK_RE, '[[$1]]');
}

/**
 * Convert `[[wikilink]]` syntax back to internal `id:` markdown links.
 *
 * Used when importing `.md` files back into the workspace so wikilinks can be
 * resolved against known file names and restored to the internal `id:` scheme.
 * Unresolved wikilinks are left as-is, which avoids silently inventing file
 * identities when a name has no unique match.
 *
 * @param body - The markdown body text containing wikilinks.
 * @param resolveName - Lookup function that returns a FileId for a given page
 * name, or null if no unique file can be resolved.
 *
 * @example
 * ```typescript
 * const body = 'See [[Meeting Notes]] for details.';
 * const resolve = (name: string) =>
 * 	name === 'Meeting Notes' ? ('abc-123' as FileId) : null;
 *
 * convertWikilinksToInternalLinks(body, resolve);
 * // 'See [Meeting Notes](id:abc-123) for details.'
 * ```
 */
export function convertWikilinksToInternalLinks(
	body: string,
	resolveName: (name: string) => FileId | null,
): string {
	return body.replace(WIKILINK_RE, (match, name: string) => {
		const fileId = resolveName(name);
		if (fileId) return `[${name}](${ID_SCHEME}${fileId})`;
		return match;
	});
}
