import { YAML } from 'bun';

/**
 * Assemble a markdown string from YAML frontmatter and an optional body.
 *
 * Pure function: no I/O. Uses `Bun.YAML.stringify` for spec-compliant
 * serialization (handles quoting of booleans, numeric strings, special
 * characters, newlines, etc.). Undefined frontmatter values are stripped
 * (missing key); null values are preserved (YAML `null`) so nullable
 * fields survive a future round-trip.
 *
 * The body is written verbatim. Any transformation (link rewriting, layout,
 * publish reshaping) is the caller's responsibility, applied before the body
 * is passed in.
 */
export function assembleMarkdown(
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
