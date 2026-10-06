/**
 * Props for mounting one `EntryCard` whose `entry` and `entries` a test can
 * change in place, the way a parent passes new props to the same card.
 */
import type { Entry } from '../../lib/data.js';
import type { EntriesState } from '../../lib/entries.svelte.js';

export function cardProps(initialEntries: EntriesState, initial: Entry) {
	let entry = $state.raw(initial);
	let entries = $state.raw(initialEntries);
	return {
		get entry() {
			return entry;
		},
		set entry(next: Entry) {
			entry = next;
		},
		get entries() {
			return entries;
		},
		set entries(next: EntriesState) {
			entries = next;
		},
		chosen: false,
		canChoose: true,
		onToggle() {},
	};
}
