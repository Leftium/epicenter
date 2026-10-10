/**
 * Canonical row documents: complete fields and Markdown body for editing.
 *
 * A document is every frontmatter field as an unvalidated JSON value plus the
 * Markdown body as opaque text. Parsing builds values by walking the YAML syntax tree,
 * so anything that would convert lossily (custom
 * tags, binary, sets, timestamps, non-string keys, unsafe integers, non-finite
 * numbers, lone surrogates, cyclic aliases) is refused before a value exists.
 * The ordinary reader's conversion also checks its alias limits on that same
 * syntax tree; its converted values are discarded.
 *
 * Formatting writes one fixed text for a document and a declared key order:
 * declared keys first in declared order, other keys in UTF-16 code unit
 * order, nested mapping keys in that order too, every key quoted and every
 * value in JSON flow style, which is valid YAML 1.2. Comments, quoting, key
 * order, a byte-order mark, and header CRLF are normalized away. The body is
 * appended byte for byte. Schema validation is not this codec's job:
 * `inspectRow` reads the formatted text like any other row text.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Document,
	isAlias,
	isMap,
	isScalar,
	isSeq,
	parseDocument,
} from 'yaml';
import { convertFrontmatter, frameRowText } from './markdown.js';

/** A JSON value with an exact YAML and JSON form. */
export type CanonicalValue =
	| null
	| boolean
	| number
	| string
	| readonly CanonicalValue[]
	| { readonly [key: string]: CanonicalValue };

/** Every frontmatter field, declared or not, and the body after the closing fence. */
export type CanonicalDocument = {
	readonly fields: { readonly [key: string]: CanonicalValue };
	readonly body: string;
};

/**
 * Why source or a document has no canonical form. `path` locates the value.
 * A refusal of source has the 1-based `line` of the whole source it points
 * at; a refusal of a document has none.
 */
export type CanonicalRefusal = {
	readonly reason: string;
	readonly path: readonly (string | number)[];
	readonly line?: number;
};

type Path = readonly (string | number)[];

const refuse = (
	reason: string,
	path: Path = [],
	line?: number,
): Result<never, CanonicalRefusal> =>
	Err(line === undefined ? { reason, path } : { reason, path, line });

/** Alias expansions allowed per document; more is refused, not evaluated. */
const MAX_ALIAS_EXPANSIONS = 100;
/** Converted nodes allowed per document, counting every alias expansion. */
const MAX_NODES = 10_000;

const TAG = 'tag:yaml.org,2002:';
const SCALAR_TAGS = new Set(
	['str', 'int', 'float', 'bool', 'null'].map((t) => TAG + t),
);

type Walk = {
	readonly document: Document.Parsed;
	readonly converting: Set<unknown>;
	/** The whole source and where its YAML starts, to locate refusals. */
	readonly source: string;
	readonly yamlStart: number;
	aliases: number;
	nodes: number;
};

/** The 1-based line of a UTF-16 index in source. A CRLF is one line break. */
function lineAt(source: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 0x0a) line++;
	return line;
}

/** The line where a YAML node starts, when the parser recorded its range. */
function lineOf(walk: Walk, node: unknown): number | undefined {
	const start = (node as { range?: readonly number[] | null } | null)
		?.range?.[0];
	return start === undefined
		? undefined
		: lineAt(walk.source, walk.yamlStart + start);
}

/**
 * Parsed row source and where its top-level keys are. A refusal inside a
 * top-level field names that `field`. Internal to the package: diagnostics
 * locate issues with it; `parseCanonicalDocument` is its public form.
 */
export function parseRowSource(source: string): Result<
	{
		readonly document: CanonicalDocument;
		/** The 1-based line of a top-level frontmatter key; found only when asked. */
		keyLine(key: string): number | undefined;
	},
	{
		readonly reason: string;
		readonly path: readonly (string | number)[];
		readonly line?: number;
		/** The top-level field the refusal is inside, when it is inside one. */
		readonly field?: string;
	}
> {
	const frame = frameRowText(source);
	if (frame.kind === 'missing')
		return refuse('The source does not start with a --- line', [], 1);
	if (frame.kind === 'unclosed')
		return refuse(
			'The frontmatter opening line has no closing --- line',
			[],
			1,
		);
	const document = parseDocument(source.slice(frame.yamlStart, frame.yamlEnd), {
		prettyErrors: false,
		uniqueKeys: true,
		version: '1.2',
		// Keeps integers exact so unsafe ones are refused instead of rounded.
		intAsBigInt: true,
	});
	const problem = document.errors[0] ?? document.warnings[0];
	if (problem !== undefined)
		return refuse(
			`The frontmatter is not supported YAML: ${problem.message}`,
			[],
			lineAt(source, frame.yamlStart + problem.pos[0]),
		);
	const body = source.slice(frame.bodyStart);
	if (!body.isWellFormed())
		return refuse(
			'The body contains a lone surrogate',
			['body'],
			lineAt(source, frame.bodyStart),
		);
	const walk: Walk = {
		document,
		converting: new Set(),
		source,
		yamlStart: frame.yamlStart,
		aliases: 0,
		nodes: 0,
	};
	if (document.contents === null)
		return Ok({ document: { fields: {}, body }, keyLine: () => undefined });
	if (!isMap(document.contents))
		return refuse(
			'The frontmatter is not a mapping',
			[],
			lineOf(walk, document.contents),
		);
	const { data: fields, error: fieldsError } = convert(
		document.contents,
		[],
		walk,
	);
	if (fieldsError !== null) {
		const [field] = fieldsError.path;
		return Err(
			typeof field === 'string' ? { ...fieldsError, field } : fieldsError,
		);
	}
	// Ordinary row reads convert this same parse under yaml's alias bound,
	// which can refuse what the count above allows. Refuse it here too, so
	// text with a canonical form always reads as an ordinary row.
	const { error: conversionError } = convertFrontmatter(document);
	if (conversionError !== null)
		return refuse(conversionError, [], lineAt(source, frame.yamlStart));
	const pairs = document.contents.items;
	return Ok({
		document: { fields: fields as CanonicalDocument['fields'], body },
		keyLine(key) {
			// Conversion refused every key that is not a string scalar.
			const pair = pairs.find((p) => isScalar(p.key) && p.key.value === key);
			return pair === undefined ? undefined : lineOf(walk, pair.key);
		},
	});
}

/**
 * Parse framed Markdown into its complete document. Every field is kept,
 * declared or not, without schema validation. A refusal carries no partial
 * document, and the line of the source it points at; keep the original text
 * available for raw repair. Parsing does not retain frontmatter comments or
 * presentation.
 */
export function parseCanonicalDocument(
	source: string,
): Result<CanonicalDocument, CanonicalRefusal> {
	const { data: parsed, error } = parseRowSource(source);
	if (error !== null) return refuse(error.reason, error.path, error.line);
	return Ok(parsed.document);
}

/**
 * Convert one node, and locate a refusal at the innermost node that made it:
 * a refusal that already has a line passes through unchanged.
 */
function convert(
	node: unknown,
	path: Path,
	walk: Walk,
): Result<CanonicalValue, CanonicalRefusal> {
	const converted = convertNode(node, path, walk);
	if (converted.error === null || converted.error.line !== undefined)
		return converted;
	const line = lineOf(walk, node);
	return line === undefined
		? converted
		: refuse(converted.error.reason, converted.error.path, line);
}

function convertNode(
	node: unknown,
	path: Path,
	walk: Walk,
): Result<CanonicalValue, CanonicalRefusal> {
	if (++walk.nodes > MAX_NODES)
		return refuse('The frontmatter expands to too many values', path);
	if (node === null) return Ok(null);
	if (isAlias(node)) {
		if (++walk.aliases > MAX_ALIAS_EXPANSIONS)
			return refuse('The frontmatter expands too many aliases', path);
		const target = node.resolve(walk.document);
		if (target === undefined)
			return refuse(`The alias *${node.source} has no anchor`, path);
		if (walk.converting.has(target))
			return refuse(`The alias *${node.source} is circular`, path);
		return convert(target, path, walk);
	}
	if (isScalar(node)) {
		if (node.tag !== undefined && !SCALAR_TAGS.has(node.tag))
			return refuse(`The tag ${node.tag} is not supported`, path);
		const { value } = node;
		if (value === null || typeof value === 'boolean') return Ok(value);
		if (typeof value === 'string')
			return value.isWellFormed()
				? Ok(value)
				: refuse('A string contains a lone surrogate', path);
		if (typeof value === 'bigint') {
			// `intAsBigInt` reads `-0` as `0n`; the source keeps the sign.
			if (value === 0n) return Ok(node.source?.startsWith('-') ? -0 : 0);
			if (
				value > BigInt(Number.MAX_SAFE_INTEGER) ||
				value < BigInt(Number.MIN_SAFE_INTEGER)
			)
				return refuse('An integer is outside the safe range', path);
			return Ok(Number(value));
		}
		if (typeof value === 'number') return numberValue(value, path);
		return refuse('A scalar has no JSON value', path);
	}
	walk.converting.add(node);
	try {
		if (isSeq(node)) {
			if (node.tag !== undefined && node.tag !== `${TAG}seq`)
				return refuse(`The tag ${node.tag} is not supported`, path);
			const items: CanonicalValue[] = [];
			for (const [index, item] of node.items.entries()) {
				const { data: value, error: valueError } = convert(
					item,
					[...path, index],
					walk,
				);
				if (valueError !== null) return Err(valueError);
				items.push(value);
			}
			return Ok(items);
		}
		if (isMap(node)) {
			if (node.tag !== undefined && node.tag !== `${TAG}map`)
				return refuse(`The tag ${node.tag} is not supported`, path);
			const record: Record<string, CanonicalValue> = {};
			for (const pair of node.items) {
				const key = pair.key;
				if (
					!isScalar(key) ||
					typeof key.value !== 'string' ||
					(key.tag !== undefined && key.tag !== `${TAG}str`)
				)
					return refuse(
						'A mapping key is not a string',
						path,
						lineOf(walk, key),
					);
				if (!key.value.isWellFormed())
					return refuse(
						'A mapping key contains a lone surrogate',
						path,
						lineOf(walk, key),
					);
				const { data: value, error: valueError } = convert(
					pair.value,
					[...path, key.value],
					walk,
				);
				if (valueError !== null) return Err(valueError);
				defineOwn(record, key.value, value);
			}
			return Ok(record);
		}
	} finally {
		walk.converting.delete(node);
	}
	return refuse('The frontmatter contains an unsupported node', path);
}

function numberValue(
	value: number,
	path: Path,
): Result<number, CanonicalRefusal> {
	if (!Number.isFinite(value)) return refuse('A number is not finite', path);
	if (Number.isInteger(value) && !Number.isSafeInteger(value))
		return refuse('An integer is outside the safe range', path);
	return Ok(value);
}

/** An own data property, so `__proto__` is a key and never a prototype. */
export function defineOwn(
	record: Record<string, unknown>,
	key: string,
	value: unknown,
) {
	Object.defineProperty(record, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/**
 * The canonical text of a document: the same bytes for the same document
 * and declared keys, whatever source it was read from. Refused when a value
 * has no exact JSON and YAML form, or when the text would not parse back to
 * the document. This checks representation, not field schemas, and writes
 * nothing. Pass the definition's field keys to choose their order.
 *
 * Only `fields` and `body` are read, once each, so a value carrying other
 * properties formats as its document. An untyped caller's document that is
 * not an object, or whose body is not a string, is refused, not thrown.
 */
export function formatCanonicalDocument(
	document: CanonicalDocument,
	declaredKeys: readonly string[],
): Result<string, CanonicalRefusal> {
	const supplied: unknown = document;
	if (typeof supplied !== 'object' || supplied === null)
		return refuse('The document is not an object');
	const { fields, body } = supplied as Record<'fields' | 'body', unknown>;
	if (typeof body !== 'string')
		return refuse('The body is not a string', ['body']);
	if (!body.isWellFormed())
		return refuse('The body contains a lone surrogate', ['body']);
	const declared = new Set(declaredKeys);
	if (declared.size !== declaredKeys.length)
		return refuse('A declared key is listed twice');
	if (!isPlainRecord(fields))
		return refuse('The fields are not a plain object');
	const extra = Object.keys(fields)
		.filter((key) => !declared.has(key))
		.sort(compareKeys);
	const keys = [
		...declaredKeys.filter((key) => Object.hasOwn(fields, key)),
		...extra,
	];
	let header = '';
	for (const key of keys) {
		const { data: text, error: textError } = flow(
			fields[key],
			[key],
			new Set(),
		);
		if (textError !== null) return Err(textError);
		const { data: quoted, error: quoteError } = quote(key, [key]);
		if (quoteError !== null) return Err(quoteError);
		header += `${quoted}: ${text}\n`;
	}
	const text = `---\n${header}---\n${body}`;
	const { data: reread, error: parseError } = parseCanonicalDocument(text);
	if (parseError !== null)
		return refuse(`The canonical text does not parse: ${parseError.reason}`);
	if (reread.body !== body || !sameValue(reread.fields, fields))
		return refuse('The canonical text does not read back as the document');
	return Ok(text);
}

function flow(
	value: unknown,
	path: Path,
	ancestors: Set<object>,
): Result<string, CanonicalRefusal> {
	if (value === null) return Ok('null');
	if (typeof value === 'boolean') return Ok(String(value));
	if (typeof value === 'number') {
		const number = numberValue(value, path);
		if (number.error !== null) return number;
		return Ok(Object.is(value, -0) ? '-0' : String(value));
	}
	if (typeof value === 'string') return quote(value, path);
	if (typeof value !== 'object')
		return refuse(`A ${typeof value} has no JSON value`, path);
	if (ancestors.has(value)) return refuse('A value contains itself', path);
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			// Holes, extra properties, and symbols would be lost.
			if (Reflect.ownKeys(value).length !== value.length + 1)
				return refuse('An array has holes or extra properties', path);
			const items: string[] = [];
			for (const [index, item] of value.entries()) {
				const { data: text, error: textError } = flow(
					item,
					[...path, index],
					ancestors,
				);
				if (textError !== null) return Err(textError);
				items.push(text);
			}
			return Ok(`[${items.join(', ')}]`);
		}
		if (!isPlainRecord(value))
			return refuse('An object is not a plain JSON object', path);
		const entries: string[] = [];
		for (const key of Object.keys(value).sort(compareKeys)) {
			const { data: quoted, error: quoteError } = quote(key, [...path, key]);
			if (quoteError !== null) return Err(quoteError);
			const { data: text, error: textError } = flow(
				value[key],
				[...path, key],
				ancestors,
			);
			if (textError !== null) return Err(textError);
			entries.push(`${quoted}: ${text}`);
		}
		return Ok(`{${entries.join(', ')}}`);
	} finally {
		ancestors.delete(value);
	}
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		return false;
	const prototype = Object.getPrototypeOf(value);
	// Symbol keys and non-enumerable properties would be lost.
	return (
		(prototype === Object.prototype || prototype === null) &&
		Reflect.ownKeys(value).length === Object.keys(value).length
	);
}

/**
 * A YAML double-quoted scalar. JSON escapes are YAML escapes; the code points
 * YAML does not allow unescaped (DEL, C1 controls, U+FEFF, U+FFFE, U+FFFF) are
 * escaped too. Everything else, U+2028 included, is written literally.
 */
function quote(text: string, path: Path): Result<string, CanonicalRefusal> {
	if (!text.isWellFormed())
		return refuse('A string contains a lone surrogate', path);
	return Ok(
		JSON.stringify(text).replace(
			/[\u007f-\u009f﻿￾￿]/g,
			(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
		),
	);
}

/** UTF-16 code unit order: fixed, locale-independent, and total. */
function compareKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

function sameValue(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left))
		return (
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((item, index) => sameValue(item, right[index]))
		);
	if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]),
		)
	);
}
