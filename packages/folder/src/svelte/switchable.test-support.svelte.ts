/**
 * A value a test can replace while a mounted component reads it. Pass it as a
 * prop getter, `{ get rowEditor() { return owner.current; } }`, and the
 * component sees each replacement as a prop update without remounting.
 */
export function switchable<T>(initial: T): { current: T } {
	let current = $state.raw(initial);
	return {
		get current() {
			return current;
		},
		set current(next: T) {
			current = next;
		},
	};
}
