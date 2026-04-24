import type {
	DocumentFactory,
	DocumentHandle,
} from '@epicenter/workspace';

/**
 * Reactive binding to a `DocumentFactory`. Opens the handle for the current
 * id and disposes it on unmount or id swap.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes. When the id changes, the factory opens a handle for
 * the new id and the effect's teardown disposes the handle for the old id;
 * the two operations may briefly overlap depending on Svelte's scheduling,
 * which the factory's refcount tolerates. Rapid flips back to a recent id
 * cancel the pending teardown (factory-level behavior).
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
		// Getter, not a plain property — `handle` is a `$derived` local and
		// must be re-read on every access to stay reactive. Returning `handle`
		// directly would snapshot the initial value and never update.
		get current() {
			return handle;
		},
	};
}
