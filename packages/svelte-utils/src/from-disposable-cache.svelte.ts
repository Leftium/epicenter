import type { DisposableCache } from '@epicenter/workspace';

/**
 * Reactive binding to a `DisposableCache`. Opens a handle for the current id
 * and disposes it on unmount or id swap.
 *
 * The id is read through `idFn` inside a `$derived`, so the handle tracks
 * prop/state changes. When the id changes, the cache opens a handle for the
 * new id and the effect's teardown disposes the handle for the old id; the
 * two operations may briefly overlap depending on Svelte's scheduling, which
 * the cache's refcount tolerates. Rapid flips back to a recent id cancel the
 * pending teardown (cache-level `gcTime` behavior).
 *
 * Why a getter (`() => id`) and not the id directly: destructured props and
 * `$state` reads are not reactive when captured at module top — see Svelte's
 * `state_referenced_locally` warning. Passing a function keeps the read
 * inside the derived's closure.
 *
 * @example
 * ```svelte
 * <script lang="ts">
 *   import { fromDisposableCache } from '@epicenter/svelte';
 *   import { referenceDocs } from '$lib/client';
 *
 *   let { id }: { id: string } = $props();
 *   const doc = fromDisposableCache(referenceDocs, () => id);
 * </script>
 *
 * <CodeMirrorEditor ytext={doc.current.content.binding} />
 * ```
 */
export function fromDisposableCache<
	Id extends string | number,
	T extends Disposable,
>(
	cache: DisposableCache<Id, T>,
	idFn: () => Id,
): { readonly current: T & Disposable } {
	const handle = $derived(cache.open(idFn()));
	$effect(() => {
		// Synchronous read tracks `handle` as a dependency AND snapshots the
		// current value so the cleanup disposes the OLD handle on swap, not
		// the new one (the `handle` binding is live).
		const h = handle;
		return () => h[Symbol.dispose]();
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
