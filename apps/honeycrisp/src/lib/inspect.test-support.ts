/**
 * The notes table's interpreter for tests that hold no folder, and the
 * entries and listings a fake folder answers with.
 *
 * The interpreter is the real one, read from the prepared definition with no
 * folder open, so a test reads text exactly as the app does.
 */
import {
	hashBytes,
	inspectRow,
	rowStemOf,
	type TableListing,
	type TableSnapshot,
} from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';
import {
	honeycrispDefinition,
	type InspectNote,
	NOTES,
	type NoteEntry,
} from './data.js';

export const inspectNote: InspectNote = (text) =>
	inspectRow(honeycrispDefinition.tables.notes, text);

/** A note file as the table lists it: the capture of `source` and how it reads. */
export async function noteEntry(
	path: string,
	source: string,
): Promise<NoteEntry> {
	return {
		path,
		stem: rowStemOf(NOTES, path) ?? '',
		text: source,
		sha256: await hashBytes(new TextEncoder().encode(source)),
		...inspectNote(source),
	};
}

/** A table listing in which every file was read. */
export function listingOf<TFields>(
	entries: readonly TableSnapshot<TFields>[],
): TableListing<TFields> {
	return entries.map((entry) => ({ path: entry.path, result: Ok(entry) }));
}
