/**
 * Defines how table rows are converted to markdown files and how filenames
 * are parsed back to row IDs. Each serializer is a pair of functions:
 * `serialize` (row → file content + filename) and `parseId` (filename → row ID).
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
 *
 * const id = serializer.parseId('abc.md');
 * // id = 'abc'
 * ```
 */
export type MarkdownSerializer = {
	/** Convert a row to markdown file content and filename. */
	serialize(row: Record<string, unknown>): {
		frontmatter: Record<string, unknown>;
		body?: string;
		filename: string;
	};
	/** Extract the row ID from a filename (for rename detection). */
	parseId(filename: string): string | null;
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
 *
 * serializer.parseId('device_xyz.md'); // 'device_xyz'
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
		parseId(filename) {
			if (!filename.endsWith('.md')) return null;
			return filename.slice(0, -3);
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
		parseId(filename) {
			if (!filename.endsWith('.md')) return null;
			return filename.slice(0, -3);
		},
	};
}

/** Nanoid IDs in this workspace are exactly 21 characters. */
const NANOID_LENGTH = 21;

/**
 * Slugify a string for use in filenames.
 *
 * Lowercases, replaces non-alphanumeric characters with dashes,
 * collapses consecutive dashes, trims leading/trailing dashes,
 * and truncates to 50 characters.
 */
function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^-|-$/g, '')
		.slice(0, 50);
}

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
 * For `parseId`, the workspace uses 21-character nanoid IDs. The parser
 * extracts the last 21 characters before `.md` as the ID. For filenames
 * shorter than 21 characters (plus `.md`), the entire stem is returned
 * as a fallback.
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
 * serializer.parseId('github-pr-review-Vk3xJ9mN2pQ8rW5tY7bHc.md');
 * // 'Vk3xJ9mN2pQ8rW5tY7bHc'
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
				const slug = slugify(titleValue);
				filename = slug ? `${slug}-${id}.md` : `${id}.md`;
			} else {
				filename = `${id}.md`;
			}

			return {
				frontmatter: { ...row },
				filename,
			};
		},
		parseId(filename) {
			if (!filename.endsWith('.md')) return null;
			const stem = filename.slice(0, -3);

			if (stem.length <= NANOID_LENGTH) return stem;

			// Extract the last 21 characters as the nanoid ID
			return stem.slice(-NANOID_LENGTH);
		},
	};
}
