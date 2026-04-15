import { YAML } from 'bun';
import { convertEpicenterLinksToWikilinks } from '../../../links.js';

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function — no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Undefined frontmatter values are stripped
 * (missing key); null values are preserved (YAML `null`) so nullable
 * fields survive a future round-trip.
 */
export function toMarkdown(
	frontmatter: Record<string, unknown>,
	body?: string,
): string {
	const cleaned: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		if (value !== undefined) {
			cleaned[key] = value;
		}
	}
	const yaml = YAML.stringify(cleaned, null, 2);
	const yamlBlock = yaml.endsWith('\n') ? yaml : `${yaml}\n`;
	return body !== undefined
		? `---\n${yamlBlock}---\n\n${body}\n`
		: `---\n${yamlBlock}---\n`;
}

export type SerializeResult = {
	filename: string;
	content: string;
};

/**
 * Convert frontmatter + body to a markdown file result.
 *
 * Applies epicenter link to wikilink conversion on body content.
 * Handles undefined body (frontmatter-only output).
 *
 * For markdown WITHOUT link conversion, use `toMarkdown()` directly:
 * ```typescript
 * serialize: (row) => ({
 *     filename: `${row.id}.md`,
 *     content: toMarkdown({ id: row.id, title: row.title }, body),
 * })
 * ```
 */
export function markdown({
	frontmatter,
	body,
	filename,
}: {
	frontmatter: Record<string, unknown>;
	body?: string;
	filename: string;
}): SerializeResult {
	return {
		filename,
		content: toMarkdown(
			frontmatter,
			body !== undefined ? convertEpicenterLinksToWikilinks(body) : body,
		),
	};
}
