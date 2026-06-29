import { whispering } from '#platform/whispering';
import type { PageLoad } from './$types';

/**
 * Gate the transformations paint on IndexedDB hydration. The table reads
 * `fromTable(whispering.tables.transformations)`, which is empty until
 * `idb.whenLoaded` resolves, so without this gate the "No transformations yet"
 * empty state flashes before transformations load from disk. SvelteKit blocks
 * the route's render until this load resolves; `whenReady` is a single promise
 * (`idb.whenLoaded`), so it resolves once and a later navigation never re-blocks.
 * Same gate as the sibling `recordings/+page.ts`.
 */
export const load: PageLoad = async () => {
	await whispering.whenReady;
};
