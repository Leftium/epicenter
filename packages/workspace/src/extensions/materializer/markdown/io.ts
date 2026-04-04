import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { YAML } from 'bun';

/**
 * Strip keys with `null` or `undefined` values from a frontmatter object.
 *
 * YAML serializers would write `key: null` — we want to omit those keys
 * entirely so the frontmatter stays clean.
 */
function stripNullish(obj: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined && value !== null) {
			result[key] = value;
		}
	}
	return result;
}

/**
 * Write a markdown file with YAML frontmatter and an optional body.
 *
 * Creates parent directories automatically. Uses `Bun.YAML.stringify`
 * for spec-compliant YAML serialization (handles quoting of booleans,
 * numeric strings, special characters, newlines, etc.) and `Bun.write`
 * for the file write. Frontmatter values that are `null` or `undefined`
 * are silently stripped.
 *
 * Output format:
 * - With body: `---\n{yaml}---\n\n{body}\n`
 * - Without body: `---\n{yaml}---\n`
 *
 * @example
 * ```typescript
 * await writeMarkdownFile('/data/posts/hello-world-abc123.md', {
 *   id: 'abc123',
 *   title: 'Hello World',
 *   tags: ['typescript', 'tutorial'],
 *   published: true,
 *   draft: undefined, // stripped
 * }, 'This is the post body.\n\nWith multiple paragraphs.');
 *
 * // Produces:
 * // ---
 * // id: abc123
 * // title: Hello World
 * // tags:
 * //   - typescript
 * //   - tutorial
 * // published: true
 * // ---
 * //
 * // This is the post body.
 * //
 * // With multiple paragraphs.
 * ```
 */
export async function writeMarkdownFile(
	filePath: string,
	frontmatter: Record<string, unknown>,
	body?: string,
): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });

	// Bun.YAML.stringify with a space arg produces block-style YAML
	// with a trailing newline, so `---\n{yaml}---` joins cleanly.
	const yaml = YAML.stringify(stripNullish(frontmatter), null, 2);
	const content =
		body !== undefined ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`;

	await Bun.write(filePath, content);
}

/**
 * Delete a markdown file from disk.
 *
 * Silently succeeds if the file doesn't exist. Useful for cleaning up
 * materialized files when rows are deleted from the workspace.
 *
 * @example
 * ```typescript
 * // Delete a materialized row file
 * await deleteMarkdownFile('/data/posts/hello-world-abc123.md');
 *
 * // Safe to call even if the file was already deleted
 * await deleteMarkdownFile('/data/posts/already-gone.md'); // no-op
 * ```
 */
export async function deleteMarkdownFile(filePath: string): Promise<void> {
	if (!(await Bun.file(filePath).exists())) return;
	await unlink(filePath);
}
