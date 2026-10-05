/**
 * Runs `read` in an effect, as a mounted component would: again whenever a
 * signal it read changes, with the function it returns as its cleanup.
 * Returns a function that stops it.
 */
export function watch(read: () => void | (() => void)): () => void {
	return $effect.root(() => {
		$effect(read);
	});
}

/** A value a mounted component reads as a prop, which a test can replace. */
export function switchable<T>(initial: T): { value: T } {
	let current = $state.raw(initial);
	return {
		get value() {
			return current;
		},
		set value(next) {
			current = next;
		},
	};
}

/** A derived over `read`, as a template's `{@const}` is. */
export function constant<T>(read: () => T): { readonly current: T } {
	const value = $derived.by(read);
	return {
		get current() {
			return value;
		},
	};
}
