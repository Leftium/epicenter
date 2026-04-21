import type {
	DocumentFactory,
	DocumentHandle,
} from '@epicenter/document';

/**
 * Reactive binding to a `DocumentFactory`. Opens the handle for the current
 * id and disposes it on unmount or id swap.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes atomically: derived re-evaluates → new handle opens →
 * effect cleanup disposes the old one → refcount for the old id drops to
 * zero and the factory's gcTime grace period starts. Rapid flips back to a
 * recent id cancel the pending teardown (factory-level behavior).
 *
 * Why a getter (`() => id`) and not the id directly: destructured props and
 * `$state` reads are not reactive when captured at module top — see Svelte's
 * `state_referenced_locally` warning. Passing a function keeps the read
 * inside the derived's closure.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { fromDocument } from '@epicenter/svelte';
 *   import { referenceDocs } from '$lib/client';
 *
 *   let { id }: { id: string } = $props();
 *   const doc = fromDocument(referenceDocs, () => id);
 * </script>
 *
 * <CodeMirrorEditor ytext={doc.current.content.binding} />
 * ```
 */
export function fromDocument<Id extends string, T>(
	factory: DocumentFactory<Id, T>,
	idFn: () => Id,
): { readonly current: DocumentHandle<T> } {
	const handle = $derived(factory.open(idFn()));
	$effect(() => {
		// Synchronous read tracks `handle` as a dependency AND snapshots the
		// current value so the cleanup disposes the OLD handle on swap, not
		// the new one (the `handle` binding is live).
		const h = handle;
		return () => h.dispose();
	});
	return {
		get current() {
			return handle;
		},
	};
}
