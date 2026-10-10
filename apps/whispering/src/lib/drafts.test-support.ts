/**
 * The open drafts a test edits, by what the views show them as. Type-only
 * imports, so this loads before the Svelte compiler plugin is registered.
 */
import type { Draft, Library } from './library.svelte.js';

function rowOf<
	TTable extends 'recordings' | 'transcriptions' | 'transformations',
>(draft: Draft | undefined, table: TTable) {
	if (draft?.kind !== 'row' || draft.table !== table)
		throw new Error(`Expected an open ${table} row, got ${draft?.kind}`);
	return draft.session as Extract<
		Draft,
		{ table: TTable; kind: 'row' }
	>['session'];
}

/** The selected recording's row session. */
export const recordingSession = (library: Library) =>
	rowOf(library.selection?.draft, 'recordings');

/** The selected transformation's row session. */
export const transformationSession = (library: Library) =>
	rowOf(library.selectedTransformation?.draft, 'transformations');

/** The open transcript draft at `path`. */
export const transcriptSession = (library: Library, path: string) =>
	rowOf(library.draftAt(path), 'transcriptions');

/** The text session of the open draft at `path`. */
export function textSession(library: Library, path: string) {
	const draft = library.draftAt(path);
	if (draft?.kind !== 'text')
		throw new Error(`Expected ${path} open as text, got ${draft?.kind}`);
	return draft.session;
}
