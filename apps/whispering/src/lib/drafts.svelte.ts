/**
 * The files open for editing in this window, one draft per path, each in its
 * own edit session (`@epicenter/svelte/edit-session`).
 *
 * A recording, transcript, or transformation that reads as a row opens as a
 * row session over its fields and body. A row file whose text is not a valid
 * row, a row the person chose to edit as text, and any other text file open
 * as a text session over the exact text. Audio and other files that are not
 * text open as what they are, with nothing to save.
 *
 * Several drafts can be open at once: the selected recording with its
 * transcripts beside it, and the selected transformation. The library decides
 * which; leaving a draft waits for its saves and releases its session. A
 * draft whose save failed or conflicted is left only when the person
 * discards that session's draft.
 */
import { type FileTable, rowPath, rowStemOf } from '@epicenter/folder';
import {
	createRowSession,
	createTextSession,
	type RowSession,
	type TextSession,
} from '@epicenter/svelte/edit-session';
import { SvelteMap } from 'svelte/reactivity';
import { audioMimeTypeOf } from './audio-format.js';
import {
	RECORDINGS,
	type RecordingFields,
	TRANSCRIPTIONS,
	TRANSFORMATIONS,
	type TranscriptionFields,
	type TransformationFields,
} from './definition.js';
import { readTextFile } from './files.js';
import type { WhisperingFolder } from './workspace/types.js';

/** The tables whose rows this window edits. */
export type RowTable =
	| typeof RECORDINGS
	| typeof TRANSCRIPTIONS
	| typeof TRANSFORMATIONS;

/** One open file, as its view shows it. */
export type Draft =
	| { readonly kind: 'loading'; readonly path: string }
	| {
			readonly kind: 'row';
			readonly table: typeof RECORDINGS;
			readonly session: RowSession<RecordingFields>;
	  }
	| {
			readonly kind: 'row';
			readonly table: typeof TRANSCRIPTIONS;
			readonly session: RowSession<TranscriptionFields>;
	  }
	| {
			readonly kind: 'row';
			readonly table: typeof TRANSFORMATIONS;
			readonly session: RowSession<TransformationFields>;
	  }
	/** Exact text. `table` names the row table when the file is one of its rows. */
	| {
			readonly kind: 'text';
			readonly table: RowTable | undefined;
			readonly session: TextSession;
	  }
	| { readonly kind: 'failed'; readonly path: string; readonly message: string }
	| {
			readonly kind: 'audio' | 'binary' | 'tooLarge';
			readonly path: string;
			readonly size: number;
	  };

export type DraftSession = Extract<Draft, { session: unknown }>['session'];

/** How a row file opens: as fields when its text reads as a row, or as text. */
export type OpenAs = 'row' | 'text';

/** The row table a path is a row of, if it is one this window edits. */
export function rowTableOf(path: string): RowTable | undefined {
	for (const table of [RECORDINGS, TRANSCRIPTIONS, TRANSFORMATIONS] as const)
		if (rowStemOf(table, path) !== undefined) return table;
	return undefined;
}

export function sessionOf(draft: Draft | undefined): DraftSession | undefined {
	return draft !== undefined && 'session' in draft ? draft.session : undefined;
}

export function pathOf(draft: Draft): string {
	return 'session' in draft ? draft.session.path : draft.path;
}

export function createDrafts(
	folder: WhisperingFolder,
	{
		locked,
		sizeOf,
	}: {
		/** Whether every session refuses input now, as while the app decides to close. */
		locked: () => boolean;
		/** A listed file's size, for a file that opens as details. */
		sizeOf: (path: string) => number;
	},
) {
	const drafts = new SvelteMap<string, Draft>();

	/** Read one row: a row session when its text reads as a row, else its text. */
	async function readRow<TFields>(
		rows: FileTable<TFields>,
		table: RowTable,
		stem: string,
		asRow: (session: RowSession<TFields>) => Draft,
	): Promise<Draft> {
		const path = rowPath(table, stem);
		const { data: stored, error } = await rows.get(stem);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				table,
				session: createTextSession(folder.files, error, { locked }),
			};
		if (error !== null) return { kind: 'failed', path, message: error.message };
		if (stored === undefined)
			return { kind: 'failed', path, message: `${path} is not in the folder.` };
		return asRow(createRowSession(rows, stored, { locked }));
	}

	/** Read `path` the way `as` opens it. */
	async function load(path: string, as: OpenAs): Promise<Draft> {
		const table = rowTableOf(path);
		const stem = table && rowStemOf(table, path);
		if (stem !== undefined && as === 'row')
			switch (table) {
				case RECORDINGS:
					return readRow(folder.tables.recordings, table, stem, (session) => ({
						kind: 'row',
						table,
						session,
					}));
				case TRANSCRIPTIONS:
					return readRow(
						folder.tables.transcriptions,
						table,
						stem,
						(session) => ({
							kind: 'row',
							table,
							session,
						}),
					);
				case TRANSFORMATIONS:
					return readRow(
						folder.tables.transformations,
						table,
						stem,
						(session) => ({ kind: 'row', table, session }),
					);
			}
		if (table === undefined && audioMimeTypeOf(path) !== undefined)
			return { kind: 'audio', path, size: sizeOf(path) };
		const { data: read, error } = await readTextFile(folder.files, path);
		if (error !== null) return { kind: 'failed', path, message: error.message };
		if (read.kind !== 'text') return { ...read, path };
		return {
			kind: 'text',
			table,
			session: createTextSession(folder.files, read.file, { locked }),
		};
	}

	/**
	 * Open `path` as `as`, keeping a draft already open there. A draft that
	 * failed to open is read again. A load that answers after the draft was
	 * left installs nothing.
	 */
	async function open(path: string, as: OpenAs = 'row'): Promise<Draft> {
		const known = drafts.get(path);
		if (known !== undefined && known.kind !== 'failed') return known;
		const loading: Draft = { kind: 'loading', path };
		drafts.set(path, loading);
		const draft = await load(path, as);
		if (drafts.get(path) !== loading) {
			sessionOf(draft)?.release();
			return drafts.get(path) ?? draft;
		}
		drafts.set(path, draft);
		return draft;
	}

	/**
	 * Leave the draft at `path`: wait for its saves, then release its session.
	 * Answers the session, leaving it open, when its save failed or conflicted
	 * and the person did not choose to discard that session's draft.
	 */
	async function leave(
		path: string,
		discard?: unknown,
	): Promise<DraftSession | undefined> {
		const draft = drafts.get(path);
		const session = sessionOf(draft);
		if (session !== undefined) {
			const settled = await session.settled();
			if (settled.status === 'error' && discard !== session) return session;
			session.release();
		}
		if (drafts.get(path) === draft) drafts.delete(path);
		return undefined;
	}

	/** Drop the draft at `path` now, without waiting for its saves. */
	function forget(path: string) {
		sessionOf(drafts.get(path))?.release();
		drafts.delete(path);
	}

	return {
		get(path: string): Draft | undefined {
			return drafts.get(path);
		},
		paths(): string[] {
			return [...drafts.keys()];
		},
		sessions(): DraftSession[] {
			return [...drafts.values()].flatMap((draft) => {
				const session = sessionOf(draft);
				return session === undefined ? [] : [session];
			});
		},
		open,
		/**
		 * Open the file at `path` again as `as`: leave its draft, then read it.
		 * Refused, keeping the draft, while its save failed or conflicted.
		 */
		async reopen(path: string, as: OpenAs): Promise<DraftSession | undefined> {
			const unsaved = await leave(path);
			if (unsaved !== undefined) return unsaved;
			await open(path, as);
			return undefined;
		},
		leave,
		forget,
		/** The draft at `from` now edits the file at `to`, after its session moved it. */
		moved(from: string, to: string) {
			const draft = drafts.get(from);
			if (draft === undefined) return;
			drafts.delete(from);
			drafts.set(to, draft);
		},
		/** Take a newer version of each open file whose session holds nothing unsaved. */
		async adopt() {
			await Promise.all(
				[...drafts.values()].map((draft) => sessionOf(draft)?.adopt()),
			);
		},
	};
}

export type Drafts = ReturnType<typeof createDrafts>;
