import { whispering } from '#platform/whispering';
import type { PageLoad } from './$types';

/**
 * Gate the recordings paint on IndexedDB hydration. The table reads
 * `fromTable(whispering.tables.recordings)`, which is empty until
 * `idb.whenLoaded` resolves, so without this gate the "No recordings yet" empty
 * state flashes before recordings load from disk. SvelteKit blocks the route's
 * render until this load resolves; `whenReady` is a single promise
 * (`idb.whenLoaded`), so it resolves once and a later navigation never re-blocks.
 */
export const load: PageLoad = async () => {
	await whispering.whenReady;
};
