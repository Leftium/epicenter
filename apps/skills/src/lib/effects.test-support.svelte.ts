/** Observe native reads with the same reactive tracking as a mounted reader. */
export function watch(read: () => void): () => void {
	return $effect.root(() => {
		$effect(read);
	});
}
