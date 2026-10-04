/**
 * Markdown row source: mandatory frontmatter framing, parsing, and
 * source-preserving patches (ADR-0462, ADR-0464).
 *
 * Row source is an opening `---` line, a YAML mapping with string keys, a
 * closing `---` line, and a body. Source that is not that shape fails
 * parsing as a whole: there are no recovered values and no recovered body.
 * Parsing knows no schema; `table.inspect` adds field conformance.
 *
 * Patching never re-emits YAML. It locates the touched value's node range in
 * the parsed frontmatter and replaces only that span, or appends a new key
 * before the closing fence. Every other byte, including comments, quoting,
 * key order, a byte-order mark, and CRLF line endings, is preserved. The
 * patched frontmatter is parsed again; if any untouched value changed or a
 * touched value does not read back exactly, the patch is refused instead of
 * written.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	isAlias,
	isMap,
	isNode,
	isScalar,
	type Node,
	parseDocument,
	stringify,
} from 'yaml';
import { type ParseError, parseError } from './reading.js';

const BOM = '﻿';

/** The located parts of a row file's text. Offsets index into the source string. */
export type SourceFrame =
	| {
			readonly kind: 'frontmatter';
			readonly bom: string;
			/** Offset of the first byte of YAML, after the opening fence line. */
			readonly yamlStart: number;
			/** Offset of the closing fence line. */
			readonly yamlEnd: number;
			readonly bodyStart: number;
			readonly newline: '\n' | '\r\n';
	  }
	/** The source does not start with an exact `---` line. */
	| { readonly kind: 'missing'; readonly bom: string }
	/** The opening line has no exact `---` line after it. */
	| { readonly kind: 'unclosed'; readonly bom: string };

/**
 * Locate frontmatter. Only an exact `---` first line opens it, after an
 * optional byte-order mark; the next exact `---` line closes it.
 */
export function frameSource(source: string): SourceFrame {
	const bom = source.startsWith(BOM) ? BOM : '';
	const start = bom.length;
	const openingNewline = source.startsWith('---\r\n', start)
		? '\r\n'
		: source.startsWith('---\n', start)
			? '\n'
			: undefined;
	if (openingNewline === undefined)
		return source.slice(start) === '---'
			? { kind: 'unclosed', bom }
			: { kind: 'missing', bom };
	const yamlStart = start + 3 + openingNewline.length;
	let lineStart = yamlStart;
	while (lineStart <= source.length) {
		const lineFeed = source.indexOf('\n', lineStart);
		const lineEnd = lineFeed < 0 ? source.length : lineFeed;
		const line = source.slice(lineStart, lineEnd).replace(/\r$/, '');
		if (line === '---') {
			return {
				kind: 'frontmatter',
				bom,
				yamlStart,
				yamlEnd: lineStart,
				bodyStart: lineFeed < 0 ? source.length : lineFeed + 1,
				newline: openingNewline,
			};
		}
		if (lineFeed < 0) break;
		lineStart = lineFeed + 1;
	}
	return { kind: 'unclosed', bom };
}

function parseFrontmatter(yaml: string) {
	return parseDocument(yaml, {
		prettyErrors: false,
		uniqueKeys: true,
		version: '1.2',
	});
}

/** Row source that is not framed frontmatter holding a string-keyed YAML mapping. */
function parseFailure(
	message: string,
	diagnostics?: readonly string[],
): Result<never, ParseError> {
	return Err(parseError(message, diagnostics));
}

type Framed = Extract<SourceFrame, { kind: 'frontmatter' }>;

type Parsed = {
	readonly frame: Framed;
	readonly document: ReturnType<typeof parseFrontmatter>;
	readonly values: Readonly<Record<string, unknown>>;
	readonly body: string;
};

function parse(source: string): Result<Parsed, ParseError> {
	const frame = frameSource(source);
	if (frame.kind === 'missing')
		return parseFailure(
			'The source does not start with a --- line opening its frontmatter',
		);
	if (frame.kind === 'unclosed')
		return parseFailure('The frontmatter opening line has no closing --- line');
	const document = parseFrontmatter(
		source.slice(frame.yamlStart, frame.yamlEnd),
	);
	/** The 1-based source line of a YAML offset. */
	const lineOf = (offset: number) =>
		source.slice(0, frame.yamlStart + offset).split('\n').length;
	if (document.errors.length > 0)
		return parseFailure(
			'The frontmatter is not valid YAML',
			document.errors.map(
				(error) => `Line ${lineOf(error.pos[0])}: ${error.message}`,
			),
		);
	const body = source.slice(frame.bodyStart);
	// An empty or comment-only block is an empty mapping.
	if (document.contents === null)
		return Ok({ frame, document, values: {}, body });
	if (!isMap(document.contents))
		return parseFailure('The frontmatter is not a mapping');
	for (const pair of document.contents.items)
		if (!isScalar(pair.key) || typeof pair.key.value !== 'string')
			return parseFailure(
				'A frontmatter key is not a string',
				isNode(pair.key) && pair.key.range != null
					? [`Line ${lineOf(pair.key.range[0])}: The key is not a string`]
					: undefined,
			);
	const { data: values, error: conversionError } = convertFrontmatter(document);
	if (conversionError !== null) return parseFailure(conversionError);
	return Ok({ frame, document, values, body });
}

/**
 * Parse row source without a schema: every frontmatter key and value, and
 * the body after the closing fence. A failure carries no partial result.
 */
export function parseSource(source: string): Result<
	{
		readonly values: Readonly<Record<string, unknown>>;
		readonly body: string;
	},
	ParseError
> {
	const { data: parsed, error: sourceError } = parse(source);
	if (sourceError !== null) return Err(sourceError);
	return Ok({ values: parsed.values, body: parsed.body });
}

/** Bounded alias expansion; larger expansions are refused, not evaluated. */
const MAX_ALIAS_COUNT = 100;

/**
 * Convert parsed frontmatter to plain values. Unresolvable aliases, excessive
 * alias expansion, and circular aliases become a refusal instead of a throw,
 * so the source stays readable and repairable.
 */
function convertFrontmatter(
	document: ReturnType<typeof parseFrontmatter>,
): Result<Record<string, unknown>, string> {
	if (document.contents === null) return Ok({});
	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
	} catch (cause) {
		return Err(
			`The frontmatter cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return Err('The frontmatter is not a mapping');
	if (isCircular(value))
		return Err('The frontmatter contains a circular alias');
	return Ok(value as Record<string, unknown>);
}

function isCircular(value: unknown, ancestors = new Set<object>()): boolean {
	if (typeof value !== 'object' || value === null) return false;
	if (ancestors.has(value)) return true;
	ancestors.add(value);
	for (const child of Object.values(value))
		if (isCircular(child, ancestors)) return true;
	ancestors.delete(value);
	return false;
}

/** A supplied value that cannot be written as YAML and read back as supplied. */
export type ValueRefusal = {
	readonly kind: 'value';
	readonly field: string;
	readonly reason: string;
};

/**
 * Why a patch was not prepared. Nothing is rewritten on any of them.
 *
 * - `unparsed`: the source does not parse, so there is nothing to patch.
 * - `value`: a supplied value cannot be written as YAML.
 * - `unsafe`: the source parses, but assigning the fields would change
 *   source the patch was not asked to change.
 */
export type PatchRefusal =
	| { readonly kind: 'unparsed'; readonly error: ParseError }
	| ValueRefusal
	| { readonly kind: 'unsafe'; readonly reason: string };

export type SourceChange = {
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly body?: string;
};

const unsafe = (reason: string): Result<never, PatchRefusal> =>
	Err({ kind: 'unsafe', reason });

/**
 * Apply field values and an optional replacement body to source that parses,
 * preserving every unrelated byte. Returns the new source or a refusal. A
 * body-only change still requires the source to parse: without both fences
 * there is no body to replace.
 */
export function patchSource(
	source: string,
	change: SourceChange,
): Result<string, PatchRefusal> {
	const { data: parsed, error: sourceError } = parse(source);
	if (sourceError !== null)
		return Err({ kind: 'unparsed', error: sourceError });
	const { frame, document, values } = parsed;
	const { data: patchedYaml, error: patchError } = patchYaml(
		source.slice(frame.yamlStart, frame.yamlEnd),
		document,
		values,
		change.fields ?? {},
		frame.newline,
	);
	if (patchError !== null) return Err(patchError);
	return Ok(
		source.slice(0, frame.yamlStart) +
			patchedYaml +
			source.slice(frame.yamlEnd, frame.bodyStart) +
			(change.body ?? source.slice(frame.bodyStart)),
	);
}

function patchYaml(
	yaml: string,
	document: Parsed['document'],
	before: Readonly<Record<string, unknown>>,
	fields: Readonly<Record<string, unknown>>,
	newline: '\n' | '\r\n',
): Result<string, PatchRefusal> {
	const entries = Object.entries(fields);
	if (entries.length === 0) return Ok(yaml);
	const contents = isMap(document.contents) ? document.contents : undefined;
	if (contents?.flow) return unsafe('the frontmatter is a flow mapping');

	type Edit = { start: number; end: number; text: string };
	const edits: Edit[] = [];
	const appended: string[] = [];
	for (const [key, value] of entries) {
		const { data: serialized, error: valueError } = valueText(key, value);
		if (valueError !== null) return Err(valueError);
		const pair = contents?.items.find(
			(item) => isScalar(item.key) && item.key.value === key,
		);
		if (pair === undefined) {
			appended.push(`${yamlKey(key)}: ${serialized}${newline}`);
			continue;
		}
		const node = pair.value;
		if (!isNode(node) || node.range == null)
			return unsafe(`the value of '${key}' has no source position`);
		if (isAlias(node) || (node as Node).anchor || (node as Node).tag)
			return unsafe(`the value of '${key}' uses an anchor, alias, or tag`);
		const [start, end] = node.range;
		const old = yaml.slice(start, end);
		const trailing = old.match(/(?:\r?\n[ \t]*)+$/)?.[0] ?? '';
		const lead = start > 0 && yaml[start - 1] === ':' ? ' ' : '';
		edits.push({ start, end, text: `${lead}${serialized}${trailing}` });
	}
	edits.sort((a, b) => b.start - a.start);
	let next = yaml;
	for (const edit of edits)
		next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
	if (appended.length > 0) {
		if (next !== '' && !next.endsWith('\n'))
			return unsafe('the frontmatter does not end with a line break');
		next += appended.join('');
	}

	// Refuse unless touched keys read back exactly and every other key is unchanged.
	const reread = parseFrontmatter(next);
	if (reread.errors.length > 0)
		return unsafe('the patched frontmatter is not valid YAML');
	const { data: after, error: conversionError } = convertFrontmatter(reread);
	if (conversionError !== null) return unsafe(conversionError);
	const expected: Record<string, unknown> = { ...before, ...fields };
	const keys = new Set([...Object.keys(expected), ...Object.keys(after)]);
	for (const key of keys)
		if (!deepEqual(expected[key], after[key]))
			return unsafe(`the patch would not preserve the value of '${key}'`);
	return Ok(next);
}

function yamlKey(key: string): string {
	return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key);
}

/** One-line YAML for a value; JSON flow style is valid YAML 1.2. */
export function serializeValue(
	value: unknown,
): Result<string, { readonly reason: string }> {
	if (value === null) return Ok('null');
	if (typeof value === 'boolean') return Ok(value ? 'true' : 'false');
	if (typeof value === 'number') {
		if (!Number.isFinite(value))
			return Err({ reason: 'a number value is not finite' });
		return Ok(String(value));
	}
	if (typeof value === 'string') {
		const plain = stringify(value, { lineWidth: 0 }).replace(/\n$/, '');
		if (
			!plain.includes('\n') &&
			!plain.startsWith('|') &&
			!plain.startsWith('>')
		)
			return Ok(plain);
		return Ok(JSON.stringify(value));
	}
	if (
		Array.isArray(value) ||
		(typeof value === 'object' && value !== undefined)
	) {
		try {
			return Ok(JSON.stringify(value));
		} catch {
			return Err({ reason: 'a value cannot be written as YAML' });
		}
	}
	return Err({ reason: `a ${typeof value} value cannot be written as YAML` });
}

/**
 * The YAML text a supplied value is written as. Refused unless that text
 * reads back as the value, so nothing is published that a reader would see
 * differently from what the caller supplied.
 */
function valueText(
	field: string,
	value: unknown,
): Result<string, ValueRefusal> {
	const refuse = (reason: string): Result<never, ValueRefusal> =>
		Err({ kind: 'value', field, reason });
	const { data: text, error: serializeError } = serializeValue(value);
	if (serializeError !== null) return refuse(serializeError.reason);
	const document = parseFrontmatter(`value: ${text}\n`);
	if (
		document.errors.length > 0 ||
		!deepEqual((document.toJS() as { value?: unknown } | null)?.value, value)
	)
		return refuse('the value does not read back from YAML as it was supplied');
	return Ok(text);
}

/** Why a supplied value cannot be saved in frontmatter, or `undefined` when it can. */
export function valueProblem(value: unknown): string | undefined {
	const { error: refusal } = valueText('', value);
	return refusal?.reason;
}

function deepEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		left === null ||
		right === null
	)
		return false;
	if (Array.isArray(left) !== Array.isArray(right)) return false;
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	if (leftKeys.length !== rightKeys.length) return false;
	return leftKeys.every((key) =>
		deepEqual(
			(left as Record<string, unknown>)[key],
			(right as Record<string, unknown>)[key],
		),
	);
}

/**
 * Complete source for a new row: both fences around the fields in the
 * supplied order, then the body. The fences are written even when there are
 * no fields and no body, because source without them does not parse.
 */
export function composeSource(
	fields: Readonly<Record<string, unknown>>,
	body: string,
): Result<string, ValueRefusal> {
	const newline = body.includes('\r\n') ? '\r\n' : '\n';
	let yaml = '';
	for (const [key, value] of Object.entries(fields)) {
		const { data: text, error: valueError } = valueText(key, value);
		if (valueError !== null) return Err(valueError);
		yaml += `${yamlKey(key)}: ${text}${newline}`;
	}
	return Ok(`---${newline}${yaml}---${newline}${body}`);
}
