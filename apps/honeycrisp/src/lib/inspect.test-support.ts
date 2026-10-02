/**
 * The notes table's interpreter for tests that hold no folder, and the
 * entries and listings a fake folder answers with.
 *
 * The interpreter is the real one, taken from a folder opened in memory that
 * nothing is ever saved to, so a test reads source exactly as the app does.
 */
import {
	hashBytes,
	rowStemOf,
	type TableListing,
	type TableSnapshot,
} from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	honeycrispDefinition,
	type InspectNote,
	NOTES,
	type NoteEntry,
} from './data.js';

const folder = expectOk(
	await openFolder({
		definition: honeycrispDefinition,
		id: 'honeycrisp-inspect-test',
		browser: {
			commitOnEdit: false,
			indexedDb: { indexedDB: new IDBFactory(), IDBKeyRange },
		},
	}),
);

export const inspectNote: InspectNote = folder.tables.notes.inspect;

/** A note file as the table lists it: the capture of `source` and how it reads. */
export async function noteEntry(
	path: string,
	source: string,
): Promise<NoteEntry> {
	return {
		path,
		stem: rowStemOf(NOTES, path) ?? '',
		source,
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
