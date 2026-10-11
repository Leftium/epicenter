import { createSubscriber } from 'svelte/reactivity';

/** The slice of `KvHandle` the adapter touches: its reads, and one feed. */
export type AdaptableKv = {
	get(key: never): unknown;
	readonly nonconforming: unknown[];
	subscribe(listener: () => void): () => void;
};

const wrappers = new WeakMap<AdaptableKv, AdaptableKv>();

/**
 * Track KV reads and call the native handle; writes keep their identities.
 *
 * Holds no values. The KV subscription attaches on the first reactive reader
 * and detaches after the last, so a remounted reader reads current values.
 * Repeated calls with the same handle return the same wrapper.
 */
export function fromKv<TKv extends AdaptableKv>(kv: TKv): TKv {
	const existing = wrappers.get(kv);
	if (existing) return existing as TKv;
	const track = createSubscriber((update) => kv.subscribe(update));
	const reactive = overrideMembers(kv, {
		get: {
			value: (key: never) => {
				track();
				return kv.get(key);
			},
		},
		nonconforming: {
			get() {
				track();
				return kv.nonconforming;
			},
		},
	});
	wrappers.set(kv, reactive);
	return reactive;
}

/**
 * Replace selected members of a native plain-object, closure-bound handle.
 *
 * Copies own descriptors onto a fresh object, so getters are not invoked at
 * wrap time, non-enumerable members stay where they were, and members of a
 * frozen source can still be replaced. Class instances are rejected: own
 * descriptors cannot carry their prototype methods.
 */
export function overrideMembers<TSource extends object>(
	source: TSource,
	overrides: Record<
		string,
		{ value: unknown; get?: never } | { get(): unknown; value?: never }
	>,
): TSource {
	const prototype = Object.getPrototypeOf(source);
	if (prototype !== null && prototype !== Object.prototype) {
		throw new TypeError(
			'Reactive adapters require plain-object, closure-bound handles',
		);
	}
	const descriptors: PropertyDescriptorMap =
		Object.getOwnPropertyDescriptors(source);
	for (const [key, override] of Object.entries(overrides)) {
		descriptors[key] = { enumerable: true, ...override };
	}
	return Object.freeze(Object.defineProperties({}, descriptors)) as TSource;
}
