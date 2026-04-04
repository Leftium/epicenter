import { mkdir, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Check whether a string value needs YAML double-quoting.
 *
 * Quotes are required when the value contains characters that are
 * syntactically significant in YAML: `:`, `#`, `[`, `]`, `{`, `}`,
 * or when it starts with a quote character (`"` or `'`).
 */
function needsQuoting(value: string): boolean {
	return (
		/[:#[\]{}]/.test(value) || value.startsWith('"') || value.startsWith("'")
	);
}

/**
 * Serialize a single JavaScript value into a YAML-compatible string.
 *
 * Handles primitives (string, number, boolean), arrays of strings (block
 * style), and falls back to `JSON.stringify` for anything else. Returns
 * `null` for `undefined` and `null` values—callers should skip the key.
 */
function serializeYamlValue(value: unknown, indent = ''): string | null {
	if (value === undefined || value === null) return null;

	if (typeof value === 'boolean') return String(value);
	if (typeof value === 'number') return String(value);

	if (typeof value === 'string') {
		return needsQuoting(value)
			? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
			: value;
	}

	if (Array.isArray(value)) {
		if (value.length === 0) return '[]';
		const lines = value.map((item) => {
			const serialized = serializeYamlValue(item, `${indent}  `);
			return `${indent}- ${serialized ?? ''}`;
		});
		return `\n${lines.join('\n')}`;
	}

	// Fallback: serialize as a quoted JSON string
	const json = JSON.stringify(value);
	return `"${json.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Write a markdown file with YAML frontmatter and an optional body.
 *
 * Creates parent directories automatically. Uses `Bun.write` for the
 * actual file write and hand-rolled YAML serialization (no `js-yaml`
 * dependency). Frontmatter values that are `null` or `undefined` are
 * silently skipped.
 *
 * Output format:
 * - With body: `---\n{yaml}\n---\n\n{body}\n`
 * - Without body: `---\n{yaml}\n---\n`
 *
 * @example
 * ```typescript
 * await writeMarkdownFile('/data/posts/hello-world-abc123.md', {
 *   id: 'abc123',
 *   title: 'Hello World',
 *   tags: ['typescript', 'tutorial'],
 *   published: true,
 *   draft: undefined, // skipped
 * }, 'This is the post body.\n\nWith multiple paragraphs.');
 *
 * // Produces:
 * // ---
 * // id: abc123
 * // title: Hello World
 * // tags:
 * // - typescript
 * // - tutorial
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

	const yamlLines: string[] = [];
	for (const [key, value] of Object.entries(frontmatter)) {
		const serialized = serializeYamlValue(value);
		if (serialized === null) continue;
		yamlLines.push(`${key}: ${serialized}`);
	}

	const yaml = yamlLines.join('\n');
	const content =
		body !== undefined
			? `---\n${yaml}\n---\n\n${body}\n`
			: `---\n${yaml}\n---\n`;

	await Bun.write(filePath, content);
}

/**
 * Delete a markdown file from disk.
 *
 * Silently succeeds if the file doesn't exist (swallows `ENOENT`).
 * Re-throws any other filesystem error. Useful for cleaning up
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
	try {
		await unlink(filePath);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
			return;
		throw error;
	}
}
