/**
 * Runs `read` in an effect, as a mounted component would: again whenever a
 * signal it read changes. Returns a function that stops it.
 */
export function watch(read: () => void): () => void {
	return $effect.root(() => {
		$effect(read);
	});
}
