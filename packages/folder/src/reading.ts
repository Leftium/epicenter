/**
 * What interpreting source text reports, for Markdown rows and `kv.json`
 * alike (ADR-0462, ADR-0487).
 *
 * A reading has two stages. Parsing fails as a whole and leaves a
 * `ParseError`. Parsed source is then checked one declared field at a time,
 * and each field that does not conform leaves a `FieldIssue`. Neither is an
 * operation failure: the text was read, and these describe it.
 *
 * Interpreted values are frozen all the way down, so a reading can never
 * come to disagree with the source text it describes.
 *
 * A declared field can carry a native callback, such as a refinement. Every
 * value a callback is shown is the folder's own and already frozen at every
 * depth: a parsed value is frozen before it is checked, and a supplied value
 * is copied and the copy frozen. So a callback cannot change what a reading
 * says about its source, and cannot reach an object a caller holds.
 */

import { type FieldMap, inputIssues, isJsonSafe } from '@epicenter/definition';

/**
 * Why source did not parse. `message` names the failure and `diagnostics`
 * keeps what the parser said. Both are written for a person repairing the
 * source: neither the wording nor the number of diagnostics is a machine
 * contract.
 *
 * A failure the parser said nothing more about has one diagnostic, and it
 * repeats `message`. An interface that shows both leaves out a diagnostic
 * equal to `message`, so the sentence is not shown twice.
 */
export type ParseError = {
	readonly message: string;
	readonly diagnostics: readonly [
		{ readonly message: string },
		...{ readonly message: string }[],
	];
};

/**
 * One reason a declared field does not conform, or is missing where a row
 * requires it. The message stands alone. Neither it nor the number of issues
 * is a machine contract.
 */
export type FieldIssue = {
	readonly field: string;
	/** JSON pointer within this field's value, when the validator identifies it. */
	readonly path?: string;
	readonly message: string;
};

/**
 * A JSON value that cannot be changed at any depth. Primitives are left as
 * they are, so a branded string keeps its brand, and so does a field whose
 * declared type is `unknown`.
 *
 * A list of unknown length is spelled as `ReadonlyArray` and not mapped: a
 * mapped array resolves its element at once, which never ends for a type
 * that contains itself, such as `JsonValue`. A tuple keeps its positions,
 * and so does one that ends in a rest: it has a position `0` a plain list
 * does not, so `[string, ...number[]]` still requires its head.
 */
export type DeepReadonly<T> = unknown extends T
	? T
	: T extends string | number | boolean | null | undefined
		? T
		: T extends readonly unknown[]
			? number extends T['length']
				? '0' extends keyof T
					? { readonly [K in keyof T]: DeepReadonly<T[K]> }
					: ReadonlyArray<DeepReadonly<T[number]>>
				: { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: { readonly [K in keyof T]: DeepReadonly<T[K]> };

/** A frozen parse error; with no diagnostics of its own, the message is the one diagnostic. */
export function parseError(
	message: string,
	diagnostics: readonly string[] = [],
): ParseError {
	const [first = message, ...rest] = diagnostics;
	return Object.freeze({
		message,
		diagnostics: Object.freeze([
			Object.freeze({ message: first }),
			...rest.map((text) => Object.freeze({ message: text })),
		] as const),
	});
}

/** Frozen copies of a validator's issues, holding only the public keys. */
export function freezeIssues(
	issues: readonly FieldIssue[],
): readonly FieldIssue[] {
	return Object.freeze(
		issues.map((issue) =>
			Object.freeze(
				issue.path === undefined
					? { field: issue.field, message: issue.message }
					: { field: issue.field, path: issue.path, message: issue.message },
			),
		),
	);
}

/**
 * Freeze a value the caller owns, at every depth, before anything checks it.
 *
 * The value must be the caller's own: fresh out of a parser or a copy, with
 * no reference anyone else holds, so freezing it freezes nobody's input. The
 * walk keeps its own record of the nodes it reached, which is how a YAML
 * alias that shares one node between two places is walked once.
 */
export function freezeDeep<T>(value: T): DeepReadonly<T> {
	const reached = new WeakSet<object>();
	const pending: unknown[] = [value];
	while (pending.length > 0) {
		const node = pending.pop();
		if (typeof node !== 'object' || node === null || reached.has(node))
			continue;
		reached.add(node);
		Object.freeze(node);
		for (const child of Object.values(node)) pending.push(child);
	}
	return value as DeepReadonly<T>;
}

/**
 * Supplied values as the folder's own, and what the prepared fields say of
 * them. Synchronous, so it finishes before anything is read and a caller
 * that changes its object afterward changes nothing that is saved.
 *
 * Each JSON value is copied and the copy frozen before its field checks it,
 * so a field's callback is shown the copy and never the caller's object. A
 * value that is not JSON is not copied: copying would flatten a class
 * instance into a plain object the field might accept. The input check
 * refuses it as it is, before any callback runs.
 *
 * The copies are held on an object with no prototype, so every supplied key
 * is kept as a key. On an ordinary object, assigning `__proto__` sets the
 * prototype instead, and that key would go unseen by the input check.
 */
export function ownSupplied(
	schemas: FieldMap,
	supplied: Readonly<Record<string, unknown>>,
	options: { complete: boolean },
): { values: Record<string, unknown>; issues: FieldIssue[] } {
	const values: Record<string, unknown> = Object.create(null);
	const uncopied: FieldIssue[] = [];
	for (const [key, value] of Object.entries(supplied)) {
		if (!isJsonSafe(value)) {
			values[key] = value;
			continue;
		}
		try {
			values[key] = freezeDeep(structuredClone(value));
		} catch {
			uncopied.push({ field: key, message: `${key} cannot be copied` });
		}
	}
	if (uncopied.length > 0) return { values, issues: uncopied };
	return { values, issues: inputIssues(schemas, values, options) };
}
