/**
 * Serialize an entry back to markdown text (the write half of the round-trip).
 *
 * Frontmatter is the typed-COLUMN layer, so the app owns its formatting and
 * re-emits it canonically (eemeli `yaml` `stringify`): key order follows the
 * object (which is disk order, since the caller edits a freshly parsed mapping;
 * a newly set key appends), and an empty mapping drops the fence entirely. The
 * body is the one rich field and is written VERBATIM, never reparsed, so prose
 * and any comments you care about live there and survive untouched.
 *
 * This is value-identity, not byte-identity. A parseable file round-trips to the
 * same VALUES (YAML 1.2 core, no Norway coercion), which is all a typed table
 * needs; exact quoting, whitespace, and frontmatter comments are not preserved.
 * That is the deliberate clean break from surgical, byte-preserving write-back:
 * "frontmatter is columns" and "byte-identical frontmatter" are in tension, and
 * the column reading wins. An invalid-AGAINST-THE-MODEL value is still a valid
 * YAML scalar, so it survives here by value and stays editable in place; only an
 * UNPARSEABLE file would lose, and the grid never writes those.
 *
 * Clearing a field is the caller deleting the key before it reaches here (the
 * nullish contract: a removed key, never `key: null`); an existing `key: null`
 * is a real value and round-trips as `null`.
 */

import { stringify } from 'yaml';

export function serializeEntry(
	frontmatter: Record<string, unknown>,
	body: string,
): string {
	if (Object.keys(frontmatter).length === 0) return body;
	return `---\n${stringify(frontmatter)}---\n${body}`;
}
