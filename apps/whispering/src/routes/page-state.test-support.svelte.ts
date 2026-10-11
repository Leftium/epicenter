/** Reactive props for a mounted fixture, as a page's own `$state` would hold them. */
export function pageState<T extends object>(initial: T): T {
	const state = $state(initial);
	return state;
}
