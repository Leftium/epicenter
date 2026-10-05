/**
 * Props for mounting one `EntryCard` whose `entry` a test can change in
 * place, the way a parent passes a new prop to the same card.
 */
import type { Entry } from '../../lib/data.js';
import type { EntriesState } from '../../lib/entries.svelte.js';

export function cardProps(entries: EntriesState, initial: Entry) {
	let entry = $state.raw(initial);
	return {
		get entry() {
			return entry;
		},
		set entry(next: Entry) {
			entry = next;
		},
		entries,
		chosen: false,
		canChoose: true,
		onToggle() {},
	};
}
