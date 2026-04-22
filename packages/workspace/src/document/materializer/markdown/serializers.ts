import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';
import type { BaseRow } from '../../attach-table.js';
import type { MarkdownShape } from './materializer.js';

/** Max slug length before the ID suffix. */
const MAX_SLUG_LENGTH = 50;

/**
 * Build an ID-only filename: `{id}.md`.
 *
 * @example
 * ```typescript
 * toIdFilename('abc123') // 'abc123.md'
 * ```
 */
export function toIdFilename(id: string): string {
	return `${id}.md`;
}

/**
 * Build a human-readable filename: `{slugified-title}-{id}.md`.
 *
 * Falls back to `{id}.md` when the title is empty, undefined, or null.
 *
 * @example
 * ```typescript
 * toSlugFilename('GitHub PR Review', 'abc123')
 * // 'github-pr-review-abc123.md'
 *
 * toSlugFilename(undefined, 'abc123')
 * // 'abc123.md'
 * ```
 */
export function toSlugFilename(
	title: string | undefined | null,
	id: string,
): string {
	if (!title || title.trim().length === 0) {
		return toIdFilename(id);
	}

	const slug = slugify(title).slice(0, MAX_SLUG_LENGTH);
	const raw = slug ? `${slug}-${id}.md` : toIdFilename(id);
	return filenamify(raw, { replacement: '-' });
}

/**
 * Build a `filename` slot that produces `{slug}-{id}.md` using a row field
 * as the slug source. Pass to `.table(t, { filename: slugFilename('title') })`.
 *
 * @example
 * ```typescript
 * .table(tables.posts, { filename: slugFilename('title') })
 * // row with title "Hello World", id "abc123" → 'hello-world-abc123.md'
 * ```
 */
export function slugFilename<TRow extends BaseRow>(
	field: keyof TRow & string,
): (row: TRow) => string {
	return (row) => {
		const value = row[field];
		return toSlugFilename(
			typeof value === 'string' ? value : undefined,
			String(row.id),
		);
	};
}

/**
 * Build a `toMarkdown` slot that moves one row field into the markdown body
 * and keeps the remaining row fields in frontmatter. Inverse of `bodyAsField`.
 *
 * @example
 * ```typescript
 * .table(tables.posts, {
 *   toMarkdown: fieldAsBody('content'),
 *   fromMarkdown: bodyAsField('content'),
 * })
 * ```
 */
export function fieldAsBody<TRow extends BaseRow>(
	field: keyof TRow & string,
): (row: TRow) => MarkdownShape {
	return (row) => {
		const { [field]: bodyValue, ...frontmatter } = row;
		return {
			frontmatter: frontmatter as Record<string, unknown>,
			body:
				bodyValue !== undefined && bodyValue !== null
					? String(bodyValue)
					: undefined,
		};
	};
}

/**
 * Build a `fromMarkdown` slot that pulls the markdown body back into a named
 * row field. Inverse of `fieldAsBody`.
 *
 * An empty or missing body becomes an empty string on the row.
 */
export function bodyAsField<TRow extends BaseRow>(
	field: keyof TRow & string,
): (parsed: MarkdownShape) => TRow {
	return (parsed) =>
		({
			...parsed.frontmatter,
			[field]: parsed.body ?? '',
		}) as TRow;
}
