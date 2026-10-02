export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

/**
 * Whether a value is JSON: null, strings, booleans, finite numbers, arrays, and
 * plain objects of the same, with no cycle.
 *
 * This is the whole question and nothing else. It sets no limit on depth or
 * width, so it walks with its own stack instead of the call stack and answers
 * for a value nested a hundred thousand deep. A node reachable by two paths is
 * fine; only a node that contains itself is a cycle.
 */
export function isJsonSafe(value: unknown): value is JsonValue {
	const ancestors = new Set<object>();
	// A node that passed once passes anywhere: it was walked whole, so no path
	// from it leads back to anything above it.
	const passed = new Set<object>();
	const open: { node: object; children: readonly unknown[]; next: number }[] =
		[];
	let current: unknown = value;
	for (;;) {
		if (typeof current === 'number') {
			if (!Number.isFinite(current)) return false;
		} else if (
			current !== null &&
			typeof current !== 'string' &&
			typeof current !== 'boolean'
		) {
			if (typeof current !== 'object' || ancestors.has(current)) return false;
			if (!passed.has(current)) {
				let children: readonly unknown[];
				if (Array.isArray(current)) children = current;
				else {
					const prototype = Object.getPrototypeOf(current);
					if (prototype !== Object.prototype && prototype !== null)
						return false;
					children = Object.values(current);
				}
				ancestors.add(current);
				open.push({ node: current, children, next: 0 });
			}
		}
		for (;;) {
			const frame = open.at(-1);
			if (frame === undefined) return true;
			if (frame.next < frame.children.length) {
				current = frame.children[frame.next++];
				break;
			}
			ancestors.delete(frame.node);
			passed.add(frame.node);
			open.pop();
		}
	}
}

/**
 * The storage budget the bounded guards below hold a value to. It is a policy
 * of the storages that use them, not part of what JSON is.
 */
export const JSON_BUDGET = { depth: 16, propertiesPerObject: 1_024 } as const;

function isJsonAtDepth(
	value: unknown,
	depth: number,
	ancestors: Set<object>,
): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean')
		return true;
	if (typeof value === 'number') return Number.isFinite(value);
	if (
		typeof value !== 'object' ||
		depth >= JSON_BUDGET.depth ||
		ancestors.has(value)
	) {
		return false;
	}
	ancestors.add(value);
	const prototype = Object.getPrototypeOf(value);
	const isValid = Array.isArray(value)
		? value.every((child) => isJsonAtDepth(child, depth + 1, ancestors))
		: (prototype === Object.prototype || prototype === null) &&
			Object.keys(value).length <= JSON_BUDGET.propertiesPerObject &&
			Object.values(value).every((child) =>
				isJsonAtDepth(child, depth + 1, ancestors),
			);
	ancestors.delete(value);
	return isValid;
}

/** JSON, within {@link JSON_BUDGET}. */
export function isJsonValue(value: unknown): value is JsonValue {
	return isJsonAtDepth(value, 0, new Set());
}

/** A JSON object, within {@link JSON_BUDGET}. */
export function isJsonObject(value: unknown): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isJsonValue(value)
	);
}
