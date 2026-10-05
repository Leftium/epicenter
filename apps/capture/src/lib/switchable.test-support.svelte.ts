/**
 * A value a test can change after mounting. Read it through a getter in the
 * props object, and the mounted component sees each change as a prop update
 * on the same nodes.
 */
export function switchable<T>(initial: T) {
	let current = $state.raw(initial);
	return {
		get value() {
			return current;
		},
		set value(next: T) {
			current = next;
		},
	};
}
