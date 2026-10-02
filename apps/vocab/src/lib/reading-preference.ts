/**
 * The one reading preference, shared by every surface that shows vocabulary or
 * conversation text. The shell provides it from this device's stored setting;
 * each reading component reads the same value, so the switch changes all of
 * them at once and there is no per-message mode.
 */
import { getContext, setContext } from 'svelte';

const READING = Symbol('Vocab reading preference');

type ReadingPreference = { readonly showPinyin: boolean };

/** Called once, by the shell. `read` is called on every access, so it stays live. */
export function provideReading(read: () => boolean) {
	setContext<ReadingPreference>(READING, {
		get showPinyin() {
			return read();
		},
	});
}

export function useReading(): ReadingPreference {
	return getContext<ReadingPreference>(READING);
}
