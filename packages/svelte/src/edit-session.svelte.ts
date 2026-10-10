/**
 * Edit sessions over `@epicenter/folder` files: the app owns the draft, the
 * folder's autosave writes it.
 *
 * A session edits one file's draft, a row (`createRowSession`) or text
 * (`createTextSession`). Each edit changes the draft and requests a save at
 * once; one write runs at a time and only the latest request waits, so rapid
 * typing writes the latest draft. A save never assigns the draft. Every write
 * is guarded by the bytes the session last saved, so a change made elsewhere,
 * or a deleted file, is `Conflict`, and the person chooses:
 *
 * - `keepMine`: read the file again and save the draft over what is there,
 *   or create it again when it was deleted.
 * - `reloadTheirs`: read the file again and replace the draft with it.
 *
 * Nothing retries on its own; `retry` requests the draft again.
 *
 * Commands (`keepMine`, `reloadTheirs`, `rename`) run one at a time and lock
 * input while they run, so no edit lands between a command's read and its
 * write; `settled` waits for a running command as well as the saves. A
 * released session takes no input, and a command that was running when it
 * was released starts nothing after its next await. The app releases a
 * session when the person leaves the file.
 */
import {
	type Autosave,
	type AutosaveError,
	type FileCapture,
	type FileError,
	type FileTable,
	type FolderFiles,
	type Row,
	type RowReadError,
	rowStemOf,
	type SaveState,
	wellFormed,
} from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result } from 'wellcrafted/result';

export const SessionError = defineErrors({
	/** Another command on this session is running. */
	Busy: () => ({
		message: 'Another change to this file is still in progress.',
	}),
	/** The app let this session go; it changes nothing more. */
	Released: () => ({ message: 'This file is no longer open here.' }),
});
export type SessionError = InferErrors<typeof SessionError>;

/** A failure a session reports: anything with a name and a message. */
type Failure = { readonly name: string; readonly message: string };

/** What reading the file again found. */
export type Reread<TValue, TOther> =
	| { readonly kind: 'value'; readonly file: FileCapture; readonly value: TValue }
	/** Nothing is at the path. */
	| { readonly kind: 'gone' }
	/**
	 * The file is there but cannot be shown as this session's value, such as
	 * a row whose text is not valid. Keep mine still saves over it.
	 */
	| { readonly kind: 'other'; readonly file: FileCapture; readonly detail: TOther };

/** How a session reaches its kind of file. */
export type EditSource<TValue, TError extends Failure, TOther> = {
	autosave(
		file: FileCapture,
		options: { onState(state: SaveState<TError>): void },
	): Autosave<TValue, TError>;
	reread(path: string): Promise<Result<Reread<TValue, TOther>, Failure>>;
	recreate(path: string, value: TValue): Promise<Result<FileCapture, Failure>>;
};

function captureOf({ path, sha256 }: FileCapture): FileCapture {
	return { path, sha256 };
}

export function createEditSession<TValue, TError extends Failure, TOther>(
	source: EditSource<TValue, TError, TOther>,
	opened: { readonly file: FileCapture; readonly value: TValue },
	{ locked: lockedOutside = () => false }: { locked?: () => boolean } = {},
) {
	let draft = $state(opened.value);
	let state = $state.raw<SaveState<TError>>({
		status: 'saved',
		file: captureOf(opened.file),
	});
	/** Advanced each time a read replaces the draft, so a view can remount. */
	let generation = $state(0);
	let command = $state.raw<Promise<unknown> | undefined>();
	let released = $state(false);
	let save!: Autosave<TValue, TError>;
	start(opened.file);

	/** A new autosave from `file`. A replaced autosave's late states are ignored. */
	function start(file: FileCapture) {
		state = { status: 'saved', file: captureOf(file) };
		const session = source.autosave(file, {
			onState(next) {
				if (save === session) state = next;
			},
		});
		save = session;
	}

	function request() {
		save.request($state.snapshot(draft) as TValue);
	}

	const locked = () => released || command !== undefined || lockedOutside();

	/** Run one command with input locked. Refused while another runs or once released. */
	async function run<T>(
		work: () => Promise<Result<T, Failure>>,
	): Promise<Result<T, Failure>> {
		if (released) return SessionError.Released();
		if (command !== undefined) return SessionError.Busy();
		const running = (async () => {
			await save.settled();
			if (released) return SessionError.Released();
			return work();
		})();
		command = running;
		try {
			return await running;
		} finally {
			command = undefined;
		}
	}

	async function settled(): Promise<SaveState<TError>> {
		while (command !== undefined) await command.catch(() => {});
		return save.settled();
	}

	/** Show what a read found in place of the draft. */
	function replace(file: FileCapture, value: TValue) {
		draft = value;
		generation += 1;
		start(file);
	}

	return {
		/** The value on screen: the caller's to read, changed only through `edit`. */
		get draft() {
			return draft;
		},
		get state() {
			return state;
		},
		get path() {
			return state.file.path;
		},
		/** Advanced each time a read replaces the draft. */
		get generation() {
			return generation;
		},
		/** Input is refused now: a command runs, the app locked it, or it was released. */
		get locked() {
			return locked();
		},
		/**
		 * Change the draft and save it: `change` mutates the draft or returns
		 * its replacement. Refused, changing nothing, while locked.
		 */
		edit(change: (draft: TValue) => TValue | void) {
			if (locked()) return;
			const next = change(draft);
			if (next !== undefined) draft = next;
			request();
		},
		/** Request the draft again after a failed save. */
		retry() {
			if (!locked()) request();
		},
		/** The latest save state once running commands and saves have finished. */
		settled,
		/** Let the session go: it takes no input, and a running command starts nothing more. */
		release() {
			released = true;
		},
		/**
		 * Reload theirs: read the file and show it in place of the draft. A file
		 * that is gone or cannot be shown is answered, and the draft stays.
		 */
		reloadTheirs(): Promise<Result<Reread<TValue, TOther>, Failure>> {
			return run(async () => {
				const found = await source.reread(state.file.path);
				if (released) return SessionError.Released();
				if (found.data?.kind === 'value')
					replace(found.data.file, found.data.value);
				return found;
			});
		},
		/** Keep mine: save the draft over whatever the file holds now, or create it again. */
		keepMine(): Promise<Result<undefined, Failure>> {
			return run(async () => {
				const path = state.file.path;
				const { data: found, error } = await source.reread(path);
				if (released) return SessionError.Released();
				if (error !== null) return Err(error);
				if (found.kind !== 'gone') {
					start(found.file);
					request();
					return Ok(undefined);
				}
				const { data: created, error: createError } = await source.recreate(
					path,
					$state.snapshot(draft) as TValue,
				);
				if (createError !== null) return Err(createError);
				// Created from the draft as it is now; input was locked meanwhile.
				start(created);
				return Ok(undefined);
			});
		},
		/**
		 * Take a newer version of the file when nothing of the person's is
		 * waiting: no command runs, the session is saved, and no edit lands
		 * while it reads. A file that is gone or cannot be shown is left for
		 * the next save to report. Answers whether the draft changed.
		 */
		async adopt(): Promise<boolean> {
			if (locked() || state.status !== 'saved') return false;
			const before = state;
			const { data: found } = await source.reread(before.file.path);
			if (locked() || state !== before || found?.kind !== 'value') return false;
			if (found.file.sha256 === before.file.sha256) return false;
			replace(found.file, found.value);
			return true;
		},
		/**
		 * Move the file once its saves have landed: `move` performs the guarded
		 * move of what the last save confirmed and answers the capture at the
		 * new path. A draft whose save failed is requested again there.
		 */
		rename(
			move: (file: FileCapture) => Promise<Result<FileCapture, Failure>>,
		): Promise<Result<undefined, Failure>> {
			return run(async () => {
				const failed = state.status === 'error';
				const { data: moved, error } = await move(state.file);
				if (error !== null) return Err(error);
				start(moved);
				if (failed && !released) request();
				return Ok(undefined);
			});
		},
	};
}

export type EditSession<TValue, TError extends Failure, TOther> = ReturnType<
	typeof createEditSession<TValue, TError, TOther>
>;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

type RowSaveErrorOf<TFields> = Parameters<
	Parameters<FileTable<TFields>['autosave']>[1]['onState']
>[0] extends SaveState<infer E>
	? E
	: never;

/** Why a row file cannot be shown as a row: its text is not a valid row, or not text. */
export type RowProblem = Extract<
	RowReadError,
	{ name: 'InvalidRow' | 'InvalidUtf8' }
>;

/** A row file's table as a session source. */
export function rowSource<TFields>(
	table: FileTable<TFields>,
): EditSource<Row<TFields>, RowSaveErrorOf<TFields>, RowProblem> {
	return {
		autosave: (file, options) => table.autosave(file, options),
		async reread(path) {
			const stem = rowStemOf(table.name, path);
			if (stem === undefined)
				return Err({ name: 'InvalidPath', message: `${path} is not a row` });
			const { data: stored, error } = await table.get(stem);
			if (error?.name === 'InvalidRow' || error?.name === 'InvalidUtf8')
				return Ok({ kind: 'other', file: captureOf(error), detail: error });
			if (error !== null) return Err(error);
			if (stored === undefined) return Ok({ kind: 'gone' });
			return Ok({ kind: 'value', file: captureOf(stored), value: stored.row });
		},
		async recreate(path, row) {
			const stem = rowStemOf(table.name, path) ?? '';
			const { data: created, error } = await table.create(row, { stem });
			return error === null ? Ok(captureOf(created)) : Err(error);
		},
	};
}

/** A session over one valid row. */
export function createRowSession<TFields>(
	table: FileTable<TFields>,
	stored: FileCapture & { readonly row: Row<TFields> },
	options?: { locked?: () => boolean },
) {
	return createEditSession(
		rowSource(table),
		{ file: stored, value: stored.row },
		options,
	);
}

export type RowSession<TFields> = ReturnType<typeof createRowSession<TFields>>;

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Text files as a session source. A file that is not UTF-8 text is `other`. */
export function textSource(
	files: FolderFiles,
): EditSource<string, FileError | AutosaveError, 'binary'> {
	return {
		autosave: (file, options) => files.autosave(file, options),
		async reread(path) {
			const { data: read, error } = await files.read(path);
			if (error?.name === 'NotFound') return Ok({ kind: 'gone' });
			if (error !== null) return Err(error);
			const file = captureOf(read);
			try {
				return Ok({ kind: 'value', file, value: utf8.decode(read.bytes) });
			} catch {
				return Ok({ kind: 'other', file, detail: 'binary' });
			}
		},
		recreate: (path, text) => files.create(path, text),
	};
}

/** A session over one text file. Input is kept well formed. */
export function createTextSession(
	files: FolderFiles,
	opened: FileCapture & { readonly text: string },
	options?: { locked?: () => boolean },
) {
	const session = createEditSession(
		textSource(files),
		{ file: opened, value: opened.text },
		options,
	);
	return Object.assign(session, {
		/** Replace the text and save it. */
		input(text: string) {
			session.edit(() => wellFormed(text));
		},
	});
}

export type TextSession = ReturnType<typeof createTextSession>;
