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
 * Files we cannot parse safely (git conflict markers, frontmatter that is not a
 * mapping, malformed YAML) return `ok: false` so the caller can route them to
 * the "Can't read" bucket instead of guessing. The grid never writes them.
 */

import { parse as parseYaml } from 'yaml';

export type ParsedFile =
	| { ok: true; frontmatter: Record<string, unknown>; body: string }
	| { ok: false; reason: 'conflict-markers' | 'invalid-yaml'; raw: string };

/**
 * Leading `---\n...\n---` block. The newline before the closing `---` is
 * optional so an empty block (`---\n---`) matches; tolerates CRLF and an
 * optional trailing newline.
 */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/;

/** A git conflict marker at the start of any line. */
const CONFLICT_MARKER = /^(<<<<<<<|=======|>>>>>>>)/m;

export function parseMarkdown(raw: string): ParsedFile {
	if (CONFLICT_MARKER.test(raw)) {
		return { ok: false, reason: 'conflict-markers', raw };
	}

	const match = raw.match(FRONTMATTER);
	if (!match) {
		// No frontmatter is fine: an empty mapping, the whole file is body.
		return { ok: true, frontmatter: {}, body: raw };
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(match[1] ?? '') ?? {};
	} catch {
		return { ok: false, reason: 'invalid-yaml', raw };
	}

	// Frontmatter must be a mapping to be usable as columns. A scalar or list at
	// the top is well-formed YAML but not a row's fields, so treat it as unreadable.
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { ok: false, reason: 'invalid-yaml', raw };
	}

	return {
		ok: true,
		frontmatter: parsed as Record<string, unknown>,
		body: raw.slice(match[0].length),
	};
}
