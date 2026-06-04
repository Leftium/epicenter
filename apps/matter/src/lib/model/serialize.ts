/**
 * Serialize one edit back into a markdown file's text (the write half of the
 * round-trip).
 *
 * The read path is `text -> { frontmatter, body }`. This is the inverse for a
 * SINGLE edit: `(current text, one edit) -> new text`, changing only what the
 * user touched and leaving every byte the editor does not understand intact.
 *
 * Frontmatter goes through eemeli `yaml`'s Document tier (`parseDocument`), NOT
 * `parse -> object -> stringify`. The Document is CST-backed, so comments, key
 * order, and the quoting of UNTOUCHED keys survive a single-field edit; a plain
 * `parse`/`stringify` would canonicalize and drop all three. This is the
 * mechanism behind the spec's "round-trip identity (never mangle)". We target
 * value/comment/order/quote preservation, not byte-minimal diffs (the fence is
 * reassembled canonically as `---\n...\n---\n`); a true CST splice is a later
 * refinement if byte-minimal diffs ever matter.
 *
 * A body edit keeps the frontmatter block BYTE-FOR-BYTE (it is never reparsed)
 * and replaces only the body region, so editing one never perturbs the other.
 *
 * Clearing a field DELETES the key, never writes `key: null`: the nullish
 * contract from `conformance.ts` (absent == explicit null == empty) read from
 * the write side. `value === undefined` is the clear signal.
 */

import { isCollection, parseDocument } from 'yaml';
import { FRONTMATTER } from './parse';

/** Split raw file text into its frontmatter inner YAML and verbatim body. */
function split(raw: string): { inner: string; body: string } {
	const match = raw.match(FRONTMATTER);
	if (!match) return { inner: '', body: raw };
	return { inner: match[1] ?? '', body: raw.slice(match[0].length) };
}

/** Does the edited document still hold at least one key? */
function hasKeys(doc: ReturnType<typeof parseDocument>): boolean {
	return isCollection(doc.contents) && doc.contents.items.length > 0;
}

/**
 * Set (or, with `value === undefined`, remove) one frontmatter key, preserving
 * every other key's comments, order, and quoting. The value's JS type becomes
 * its YAML type (a string that looks numeric stays quoted; a number stays bare),
 * so `Schema.Compile` on the read side classifies it the way the user meant.
 *
 * Removing the last key drops the whole frontmatter block (an empty `---\n---`
 * fence is noise); the file becomes body-only.
 */
export function setField(raw: string, key: string, value: unknown): string {
	const { inner, body } = split(raw);
	const doc = parseDocument(inner);
	if (value === undefined) doc.delete(key);
	else doc.set(key, value);
	if (!hasKeys(doc)) return body;
	return `---\n${doc.toString()}---\n${body}`;
}

/**
 * Replace the body, keeping the frontmatter block byte-for-byte. `match[0]` is
 * the exact fence (its delimiters and trailing newline included), so reattaching
 * the new body reproduces the original separator with no reparse of the YAML.
 */
export function setBody(raw: string, body: string): string {
	const match = raw.match(FRONTMATTER);
	if (!match) return body;
	return match[0] + body;
}
