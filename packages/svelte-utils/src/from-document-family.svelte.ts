import type { DocumentFamily } from '@epicenter/workspace';

/**
 * Reactive binding to a document family. Opens a handle for the current id and
 * disposes it on unmount or id swap.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes. When the id changes, the family opens a handle for the
 * new id and the effect's teardown disposes the handle for the old id. The two
 * operations may briefly overlap depending on Svelte's scheduling; document
 * family implementations own the resulting lifetime behavior.
 *
 * Why a getter (`() => id`) and not the id directly: destructured props and
 * `$state` reads are not reactive when captured at module top. See Svelte's
 * `state_referenced_locally` warning. Passing a function keeps the read
 * inside the derived's closure.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { fromDocumentFamily } from '@epicenter/svelte';
 *   import { referenceDocs } from '$lib/client';
 *
 *   let { id }: { id: string } = $props();
 *   const doc = fromDocumentFamily(referenceDocs, () => id);
 * </script>
 *
 * <CodeMirrorEditor ytext={doc.current.content.binding} />
 * ```
 */
export function fromDocumentFamily<
	Id extends string | number,
	T extends Disposable,
>(family: DocumentFamily<Id, T>, idFn: () => Id): { readonly current: T } {
	const handle = $derived(family.open(idFn()));
	$effect(() => {
		// Synchronous read tracks `handle` as a dependency AND snapshots the
		// current value so the cleanup disposes the OLD handle on swap, not
		// the new one (the `handle` binding is live).
		const h = handle;
		return () => h[Symbol.dispose]();
	});
	return {
		// Getter, not a plain property. `handle` is a `$derived` local and
		// must be re-read on every access to stay reactive. Returning `handle`
		// directly would snapshot the initial value and never update.
		get current() {
			return handle;
		},
	};
}
