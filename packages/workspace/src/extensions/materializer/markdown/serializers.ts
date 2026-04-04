import slugify from '@sindresorhus/slugify';
import filenamify from 'filenamify';

/**
 * Defines how a table row is converted to a markdown file. The serializer
 * maps row fields to YAML frontmatter, an optional markdown body, and a
 * filename.
 *
 * Three built-in factories cover common patterns:
 * - {@link defaultSerializer} — all fields as frontmatter, `{id}.md` filename
 * - {@link bodyFieldSerializer} — one field becomes the markdown body
 * - {@link titleFilenameSerializer} — human-readable `{slug}-{id}.md` filenames
 *
 * @example
 * ```typescript
 * const serializer: MarkdownSerializer = defaultSerializer();
 * const { frontmatter, filename } = serializer.serialize({ id: 'abc', title: 'Hello' });
 * // frontmatter = { id: 'abc', title: 'Hello' }
 * // filename = 'abc.md'
 * ```
 */
export type MarkdownSerializer = {
	/** Convert a row to markdown file content and filename. */
	serialize(row: Record<string, unknown>): {
		frontmatter: Record<string, unknown>;
		body?: string;
		filename: string;
	};
};

/**
 * Create a serializer that puts all row fields into YAML frontmatter
 * with no markdown body. Files are named `{id}.md`.
 *
 * This is the simplest serializer and a good default for tables where
 * every field is a short value (IDs, URLs, timestamps). Use
 * {@link bodyFieldSerializer} instead when one field contains long-form
 * text that benefits from being the markdown body.
 *
 * @example
 * ```typescript
 * const serializer = defaultSerializer();
 *
 * const result = serializer.serialize({
 *   id: 'device_xyz',
 *   name: 'Chrome on macOS',
 *   lastSeen: '2026-04-04',
 *   browser: 'chrome',
 * });
 * // result.frontmatter = { id: 'device_xyz', name: 'Chrome on macOS', ... }
 * // result.body = undefined
 * // result.filename = 'device_xyz.md'
 * ```
 */
export function defaultSerializer(): MarkdownSerializer {
	return {
		serialize(row) {
			return {
				frontmatter: { ...row },
				filename: `${row.id}.md`,
			};
		},
	};
}

/**
 * Create a serializer that extracts one field as the markdown body and
 * puts all remaining fields into YAML frontmatter. Files are named `{id}.md`.
 *
 * Use this when a table has a long-form text field (descriptions, notes,
 * content) that reads better as markdown body text than as a frontmatter
 * value. The field value is converted to a string; if it's `undefined`
 * or missing, no body is written.
 *
 * @param fieldName - The row field to use as the markdown body.
 *
 * @example
 * ```typescript
 * const serializer = bodyFieldSerializer('description');
 *
 * const result = serializer.serialize({
 *   id: 'bk_001',
 *   title: 'React Docs',
 *   url: 'https://react.dev',
 *   description: 'Official React documentation with hooks guide.',
 * });
 * // result.frontmatter = { id: 'bk_001', title: 'React Docs', url: 'https://react.dev' }
 * // result.body = 'Official React documentation with hooks guide.'
 * // result.filename = 'bk_001.md'
 * ```
 */
export function bodyFieldSerializer(fieldName: string): MarkdownSerializer {
	return {
		serialize(row) {
			const { [fieldName]: bodyValue, ...rest } = row;
			return {
				frontmatter: rest,
				body:
					bodyValue !== undefined && bodyValue !== null
						? String(bodyValue)
						: undefined,
				filename: `${row.id}.md`,
			};
		},
	};
}

/** Max slug length before the ID suffix. */
const MAX_SLUG_LENGTH = 50;

/**
 * Create a serializer that produces human-readable filenames by slugifying
 * a title field: `{slugified-title}-{id}.md`. All row fields go into YAML
 * frontmatter with no markdown body.
 *
 * This is ideal for tables where users browse files by name (saved tabs,
 * bookmarks). The ID suffix guarantees uniqueness even when two rows share
 * the same title. If the title field is empty or missing, falls back to
 * `{id}.md`.
 *
 * @param fieldName - The row field containing the title to slugify.
 *
 * @example
 * ```typescript
 * const serializer = titleFilenameSerializer('title');
 *
 * const result = serializer.serialize({
 *   id: 'Vk3xJ9mN2pQ8rW5tY7bHc',
 *   title: 'GitHub PR Review',
 *   url: 'https://github.com/EpicenterHQ/epicenter/pull/42',
 * });
 * // result.filename = 'github-pr-review-Vk3xJ9mN2pQ8rW5tY7bHc.md'
 * // result.frontmatter = { id: 'Vk3xJ9mN2pQ8rW5tY7bHc', title: 'GitHub PR Review', ... }
 *
 * // Falls back to {id}.md when title is missing
 * serializer.serialize({ id: 'abc123', title: '' });
 * // filename = 'abc123.md'
 * ```
 */
export function titleFilenameSerializer(fieldName: string): MarkdownSerializer {
	return {
		serialize(row) {
			const titleValue = row[fieldName];
			const id = String(row.id);
			let filename: string;

			if (
				titleValue &&
				typeof titleValue === 'string' &&
				titleValue.trim().length > 0
			) {
				const slug = slugify(titleValue).slice(0, MAX_SLUG_LENGTH);
				const raw = slug ? `${slug}-${id}.md` : `${id}.md`;
				filename = filenamify(raw, { replacement: '-' });
			} else {
				filename = `${id}.md`;
			}

			return {
				frontmatter: { ...row },
				filename,
			};
		},
	};
}
