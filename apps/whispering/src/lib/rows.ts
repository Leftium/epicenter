/**
 * What the app asks of a saved row as a whole.
 *
 * A snapshot is a row file that was read: its source is always there, beside
 * how that text reads. An action reads the fields it needs from the snapshot
 * directly, so an issue in one field does not stop an action that needs
 * another. Only the "Needs repair" mark is about the whole row.
 */
import type { TableSnapshot } from '@epicenter/folder';

/** Whether a saved row's text fails to parse or leaves a declared field with an issue. */
export function needsRepair(entry: TableSnapshot<unknown>): boolean {
	return entry.parseError !== undefined || entry.issues.length > 0;
}
