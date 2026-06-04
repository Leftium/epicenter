/**
 * Parse a markdown file into frontmatter + body.
 *
 * Only the frontmatter is structurally parsed (a fenced YAML block at the top);
 * the body is returned verbatim and never AST-parsed. This is what sidesteps
 * markdown's context-sensitivity entirely: the structured layer is YAML, the
 * prose layer is opaque text.
 *
 * The `yaml` package parses with the YAML 1.2 core schema, which does NOT do
 * the YAML 1.1 "Norway problem" coercions (`NO` -> false, `1.10` -> 1.1). That
 * is the deliberate guard against the one real looseness risk in this design.
 *
 * Files we cannot parse safely return an `Err`, split by failure mode (conflict
 * markers, malformed YAML, frontmatter that is not a mapping), so the caller can
 * route them to the "Can't read" bucket instead of guessing. The grid never
 * writes them.
 */

import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { parse as parseYaml } from 'yaml';

/** Why a markdown file could not be parsed into a row. */
export const MatterParseError = defineErrors({
	ConflictMarkers: () => ({
		message: 'Contains git conflict markers',
	}),
	InvalidYaml: ({ cause }: { cause: unknown }) => ({
		message: `Frontmatter is not valid YAML: ${extractErrorMessage(cause)}`,
		cause,
	}),
	FrontmatterNotMapping: () => ({
		message: 'Frontmatter is not a key-value mapping',
	}),
});
export type MatterParseError = InferErrors<typeof MatterParseError>;

/** A markdown file split into its frontmatter mapping and verbatim body. */
export type ParsedFile = {
	frontmatter: Record<string, unknown>;
	body: string;
};

/**
 * Leading `---\n...\n---` block. The newline before the closing `---` is
 * optional so an empty block (`---\n---`) matches; tolerates CRLF and an
 * optional trailing newline.
 *
 * Exported so the write path (`serialize.ts`) splits the file at the SAME
 * boundary it was parsed at: read and write must agree on where the frontmatter
 * ends and the verbatim body begins, or a round-trip would shift bytes.
 */
export const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/;

/** A git conflict marker at the start of any line. */
const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)/m;

export function parseMarkdown(
	raw: string,
): Result<ParsedFile, MatterParseError> {
	if (CONFLICT_MARKER.test(raw)) return MatterParseError.ConflictMarkers();

	const match = raw.match(FRONTMATTER);
	// No frontmatter is fine: an empty mapping, the whole file is body.
	if (!match) return Ok({ frontmatter: {}, body: raw });

	const { data: parsed, error } = trySync({
		try: () => parseYaml(match[1] ?? '') ?? {},
		catch: (cause) => MatterParseError.InvalidYaml({ cause }),
	});
	if (error) return Err(error);

	// Frontmatter must be a mapping to be usable as columns. A scalar or list at
	// the top is well-formed YAML but not a row's fields, so treat it as unreadable.
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return MatterParseError.FrontmatterNotMapping();
	}

	return Ok({
		frontmatter: parsed as Record<string, unknown>,
		body: raw.slice(match[0].length),
	});
}
