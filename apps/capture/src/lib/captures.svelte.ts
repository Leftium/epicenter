/**
 * The Capture product state over one opened folder.
 *
 * The timeline is the last listing of `captures/*.md`. It is read when the
 * page opens, after each of the app's own actions, and when the person
 * returns to the window; the latest listing wins. It offers the files that
 * read as captures and names the rest, with why, for repair as text.
 *
 * One capture is open at a time, in one edit session
 * (`@epicenter/svelte/edit-session`): as a capture, a row session whose body
 * the capture form edits as text and thoughts; or as text, a text session
 * over the file's exact Markdown, which is how a file that is not a valid
 * capture is repaired. Leaving waits for the session's saves, then releases
 * it and lists again. A save that failed or conflicted, or a thought typed
 * and not added, keeps the capture open until the person discards it (`open`
 * and `back` answer `unsaved`, and the view asks).
 *
 * Returning to the window takes a newer version of the open capture when its
 * session holds nothing unsaved. Otherwise the next save reports the change
 * as a conflict, and the person keeps theirs or reloads.
 */
import {
	CAPTURES_TABLE,
	type CaptureFields,
	captureBody,
	composeBody,
	excerpt,
} from '@epicenter/capture';
import {
	type ImportReport,
	type LegacyBundle,
	runLegacyImport,
} from '@epicenter/capture/legacy';
import {
	type RowReadError,
	rowPath,
	rowStemOf,
	type StoredRow,
} from '@epicenter/folder';
import {
	createRowSession,
	createTextSession,
	type Reread,
	type RowProblem,
	type RowSession,
	type TextSession,
	textSource,
} from '@epicenter/svelte/edit-session';
import { createSubscriber } from 'svelte/reactivity';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import { type CaptureForm, createCaptureForm } from './capture-form.svelte.js';
import type { CaptureHost } from './platform/types.js';

const log = createLogger('capture');

/** A failure as a session or the folder reports it. */
type Failure = { readonly name: string; readonly message: string };

export type Captures = ReturnType<typeof createCaptures>;

/** How a capture is open: its text and thoughts, or its exact Markdown. */
export type Mode = 'capture' | 'text';

/** The one open capture: what the detail shows. */
export type Opened =
	| { readonly kind: 'loading'; readonly stem: string; readonly mode: Mode }
	| {
			readonly kind: 'capture';
			readonly stem: string;
			readonly session: RowSession<CaptureFields>;
			readonly form: CaptureForm;
	  }
	| { readonly kind: 'text'; readonly stem: string; readonly session: TextSession }
	| {
			readonly kind: 'failed';
			readonly stem: string;
			readonly mode: Mode;
			readonly message: string;
	  };

/** A capture the timeline lists. */
export type TimelineRow = {
	readonly stem: string;
	readonly path: string;
	/** `undefined` when `capturedAt` is not a date and time this page can read. */
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
};

/** A capture file the timeline cannot show, and why, for repair as text. */
export type Repair = {
	readonly stem: string;
	readonly path: string;
	readonly problem: string;
};

/** Why input or an action was refused while Epicenter asks to quit or restart. */
export const DEPARTING =
	'Epicenter is asking to quit or restart, so nothing is changed now. Your text is kept.';
const CLOSING = 'Capture is closing, so nothing was changed.';
/** Why Reload theirs showed nothing: the file is there but is not text. */
const NOT_TEXT =
	'This file is no longer text, so it cannot be shown here. Keep mine saves your version over it.';

/**
 * Library errors state failures precisely; these are the ones a person acts
 * on. A lost reply leaves the outcome unknown.
 */
export function describeError(error: {
	readonly name: string;
	readonly message: string;
	readonly actualSha256?: string | undefined;
	readonly issues?: readonly { readonly message: string }[];
}): string {
	switch (error.name) {
		case 'Conflict':
			return error.actualSha256 === undefined
				? 'The file is no longer in the folder. Nothing was changed.'
				: 'The file changed elsewhere. Nothing was changed.';
		case 'Unconfirmed':
			return `The change was sent, but nothing confirmed it, so it may or may not have happened. ${error.message}`;
		case 'InvalidValues':
			return (error.issues ?? []).map((issue) => issue.message).join(' ');
		default:
			return error.message;
	}
}

/** A readable, sortable stem: the capture's UTC time and a short random suffix. */
function newStem(at: Date): string {
	const stamp = at
		.toISOString()
		.slice(0, 19)
		.replace(/[-:]/g, '')
		.replace('T', '-');
	const suffix = Array.from(crypto.getRandomValues(new Uint8Array(3)), (byte) =>
		byte.toString(36).padStart(2, '0'),
	)
		.join('')
		.slice(0, 5);
	return `${stamp}-${suffix}`;
}

/** The instant of a `capturedAt` value, or `undefined` when it is not one. */
export function instantOf(value: unknown): Date | undefined {
	if (typeof value !== 'string') return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

/** Newest first by the instant, not the text: offsets differ between files. */
function newestFirst(left: TimelineRow, right: TimelineRow) {
	const a = left.capturedAt?.getTime();
	const b = right.capturedAt?.getTime();
	if (a !== b) {
		if (a === undefined) return 1;
		if (b === undefined) return -1;
		return b - a;
	}
	return left.stem < right.stem ? -1 : left.stem > right.stem ? 1 : 0;
}

function byPath(left: { path: string }, right: { path: string }) {
	return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

/** Why a listed file has no row to show. */
function readProblem(error: RowReadError): string {
	if (error.name === 'InvalidRow')
		return error.issues.map((issue) => issue.message).join(' ');
	if (error.name === 'InvalidUtf8') return 'It is not UTF-8 text.';
	return error.message;
}

export function createCaptures(host: Pick<CaptureHost, 'folder' | 'location'>) {
	const { folder } = host;
	const table = folder.tables.captures;
	const pathOf = (stem: string) => rowPath(CAPTURES_TABLE, stem);

	let timeline = $state.raw<TimelineRow[]>([]);
	let repairs = $state.raw<Repair[]>([]);
	/** Capture files that are not text, or could not be read. */
	let unreadable = $state.raw<{ path: string; message: string }[]>([]);
	/** Why the folder could not be listed, when it could not. */
	let listProblem = $state<string | undefined>();
	let loaded = $state(false);
	let opened = $state.raw<Opened | undefined>();
	let newCapture = $state('');
	const trackGit = createSubscriber((update) => folder.git.subscribe(update));
	/** The Epicenter service that served this page has stopped. */
	let serviceStopped = $state(false);
	/** Epicenter asks to quit or restart: no action starts, and the open capture takes no input. */
	let departing = $state(false);
	let closing: Promise<void> | undefined;
	let refreshSequence = 0;
	/** Advanced by every open and close, so a load that answers late installs nothing. */
	let openSequence = 0;
	/** Actions admitted and not finished: a departure and `close` wait for them. */
	const operations = new Set<Promise<unknown>>();
	let running = $state(0);

	const locked = () => departing || closing !== undefined;

	/** Why no action starts now, if one does not. */
	function refused(): string | undefined {
		if (closing !== undefined) return CLOSING;
		if (departing) return DEPARTING;
		return undefined;
	}

	/** Count `work` as running until it settles. */
	function admitted<T>(work: Promise<T>): Promise<T> {
		operations.add(work);
		running = operations.size;
		const done = () => {
			operations.delete(work);
			running = operations.size;
		};
		work.then(done, done);
		return work;
	}

	async function quiet() {
		while (operations.size > 0) await Promise.allSettled([...operations]);
	}

	/**
	 * Whether `item`, its saves ended in `status`, holds what leaving would
	 * lose: a draft it could not save, or a thought typed and not added.
	 */
	function holdsUnsaved(item: Opened | undefined, status: string | undefined) {
		return status === 'error' || (item?.kind === 'capture' && item.form.unsent);
	}

	function sessionOf(item: Opened | undefined) {
		return item?.kind === 'capture' || item?.kind === 'text'
			? item.session
			: undefined;
	}

	/** One listing pass. A pass that a newer one overtook changes nothing. */
	async function refresh() {
		if (closing !== undefined) return;
		const sequence = ++refreshSequence;
		const { data: listed, error } = await table.list();
		if (closing !== undefined || sequence !== refreshSequence) return;
		// Keep the previous listing visible; never show an empty one for a failed read.
		if (error !== null) {
			listProblem = error.message;
			return;
		}
		const rows: TimelineRow[] = [];
		const repair: Repair[] = [];
		const others: { path: string; message: string }[] = [];
		for (const { stem, result } of listed) {
			const path = pathOf(stem);
			if (result.error?.name === 'InvalidRow') {
				repair.push({ stem, path, problem: readProblem(result.error) });
				continue;
			}
			if (result.error !== null) {
				others.push({ path, message: readProblem(result.error) });
				continue;
			}
			const { row } = result.data;
			const { data: body, error: refusal } = captureBody.decode(row.body);
			if (refusal !== null) {
				repair.push({ stem, path, problem: refusal.message });
				continue;
			}
			rows.push({
				stem,
				path,
				capturedAt: instantOf(row.fields.capturedAt),
				preview: excerpt(body.text),
				thoughtCount: body.thoughts.length,
			});
		}
		listProblem = undefined;
		loaded = true;
		timeline = rows.sort(newestFirst);
		repairs = repair.sort(byPath);
		unreadable = others.sort(byPath);
	}

	/** The listing, and a newer version of the open capture when it holds nothing unsaved. */
	async function check() {
		if (closing !== undefined) return;
		const item = opened;
		const adopt =
			item?.kind === 'capture' && item.form.unsent
				? undefined
				: sessionOf(item)?.adopt();
		await Promise.all([refresh(), adopt]);
	}

	/**
	 * Leave the open capture: wait for its saves, then release its session.
	 * Answers false, leaving it open, when a save failed or conflicted or a
	 * thought is typed and not added, unless the person chose to discard
	 * that session's draft.
	 */
	async function leave(discard: unknown): Promise<boolean> {
		const item = opened;
		const session = sessionOf(item);
		if (session === undefined) return true;
		const settled = await session.settled();
		if (holdsUnsaved(item, settled.status) && discard !== session) return false;
		session.release();
		return true;
	}

	function openRow(stem: string, stored: StoredRow<CaptureFields>): Opened {
		const session = createRowSession(table, stored, { locked });
		return { kind: 'capture', stem, session, form: createCaptureForm(session) };
	}

	/** The file's exact text, as a text session. */
	async function loadText(stem: string): Promise<Opened> {
		const { data: found, error } = await textSource(folder.files).reread(
			pathOf(stem),
		);
		if (error !== null)
			return { kind: 'failed', stem, mode: 'text', message: error.message };
		if (found.kind === 'gone')
			return {
				kind: 'failed',
				stem,
				mode: 'text',
				message: 'This capture is no longer in the folder.',
			};
		if (found.kind === 'other')
			return {
				kind: 'failed',
				stem,
				mode: 'text',
				message: 'This file is not UTF-8 text, so it cannot be edited here.',
			};
		return {
			kind: 'text',
			stem,
			session: createTextSession(
				folder.files,
				{ ...found.file, text: found.value },
				{ locked },
			),
		};
	}

	/**
	 * Read `stem` the way `mode` opens it. A file that is not a valid capture
	 * opens as text whichever was asked.
	 */
	async function load(stem: string, mode: Mode): Promise<Opened> {
		if (mode === 'text') return loadText(stem);
		const { data: stored, error } = await table.get(stem);
		if (error?.name === 'InvalidRow')
			return {
				kind: 'text',
				stem,
				session: createTextSession(folder.files, error, { locked }),
			};
		if (error !== null)
			return { kind: 'failed', stem, mode, message: readProblem(error) };
		if (stored === undefined)
			return {
				kind: 'failed',
				stem,
				mode,
				message: 'This capture is no longer in the folder.',
			};
		if (captureBody.decode(stored.row.body).error !== null) return loadText(stem);
		return openRow(stem, stored);
	}

	/**
	 * Show `stem` as `mode` edits it. The open capture's saves land first,
	 * and the timeline is read again. Answers `unsaved`, opening nothing,
	 * when the open capture holds something it could not save; the view asks
	 * the person, and `discard` names the session they chose to let go.
	 */
	async function open(
		stem: string,
		mode: Mode,
		{ discard }: { discard?: unknown } = {},
	): Promise<'unsaved' | undefined> {
		if (closing !== undefined) return undefined;
		const sequence = ++openSequence;
		const left = opened;
		if (!(await leave(discard))) return 'unsaved';
		if (left !== undefined) void refresh();
		if (sequence !== openSequence || closing !== undefined) return undefined;
		opened = { kind: 'loading', stem, mode };
		const item = await load(stem, mode);
		if (sequence !== openSequence || closing !== undefined) {
			sessionOf(item)?.release();
			return undefined;
		}
		opened = item;
		return undefined;
	}

	/** Close the open capture without saving more. */
	function forget() {
		sessionOf(opened)?.release();
		openSequence += 1;
		opened = undefined;
	}

	/** Whether the open capture has a save running, a draft it could not save, or unsent input. */
	function unsaved() {
		const item = opened;
		const status = sessionOf(item)?.state.status;
		return status === 'saving' || holdsUnsaved(item, status);
	}

	return {
		location: host.location,
		/** Captures that read as one, newest first, as last listed. */
		get timeline() {
			return timeline;
		},
		/** Capture files the timeline cannot show, with why; each opens as text. */
		get repairs() {
			return repairs;
		},
		get unreadable() {
			return unreadable;
		},
		get listProblem() {
			return listProblem;
		},
		get loaded() {
			return loaded;
		},
		get git() {
			trackGit();
			return folder.git.snapshot;
		},
		/** The folder's owner closed it: nothing saves from this window again. */
		get folderStopped() {
			trackGit();
			return folder.git.snapshot.closed;
		},
		get serviceStopped() {
			return serviceStopped;
		},
		/** Saving is the folder's and carries on; the page can load nothing more. */
		markServiceStopped() {
			serviceStopped = true;
		},
		/** Leaving or closing refuses input and actions. */
		get fenced() {
			return locked();
		},
		/** The open capture, or `undefined`. */
		get opened() {
			return opened;
		},
		get unsaved() {
			return unsaved();
		},
		/** How many things leaving now could lose: the open capture, the New capture text, running actions. */
		get unsettled() {
			return (unsaved() ? 1 : 0) + (newCapture === '' ? 0 : 1) + running;
		},
		get newCapture() {
			return newCapture;
		},
		inputNewCapture(value: string) {
			if (!locked()) newCapture = value;
		},
		refresh,
		/** Returning to the window. */
		check,
		open,
		/** Leave the open capture for the timeline. Answers `unsaved` as `open` does. */
		async back({ discard }: { discard?: unknown } = {}): Promise<
			'unsaved' | undefined
		> {
			const sequence = ++openSequence;
			if (!(await leave(discard))) return 'unsaved';
			if (sequence === openSequence) opened = undefined;
			await refresh();
			return undefined;
		},
		/**
		 * Reload theirs for `session`, the open capture's: show the file as it
		 * is now. A capture whose text is no longer a valid row opens as text;
		 * a file that is gone closes. Answers what the person is told, if
		 * anything.
		 */
		async reloadTheirs(
			session: RowSession<CaptureFields> | TextSession,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const item = opened;
			if (item === undefined || sessionOf(item) !== session) return undefined;
			const { data: found, error } = await admitted<
				Result<Reread<unknown, RowProblem | 'binary'>, Failure>
			>(session.reloadTheirs());
			if (error !== null) return describeError(error);
			if (opened !== item) return undefined;
			if (found.kind === 'gone') forget();
			else if (found.kind === 'other') {
				// Only a capture's text that is no longer a valid row can be shown, as text.
				const { detail } = found;
				if (detail === 'binary' || detail.name !== 'InvalidRow') return NOT_TEXT;
				session.release();
				opened = {
					kind: 'text',
					stem: item.stem,
					session: createTextSession(folder.files, detail, { locked }),
				};
			}
			await refresh();
			return undefined;
		},
		/** Keep mine for `session`, the open capture's: save the draft over the file, or create it again. */
		async keepMine(
			session: RowSession<CaptureFields> | TextSession,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			if (sessionOf(opened) !== session) return undefined;
			const { error } = await admitted(session.keepMine());
			await refresh();
			return error === null ? undefined : describeError(error);
		},

		/**
		 * Save the New capture text as a new file and open it. The text stays
		 * in the form when the save fails. Answers what the person is told.
		 */
		async create(): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const text = newCapture;
			// Blank text is refused and stays in the form: only the person clears it.
			if (text.trim() === '') return 'Write something first.';
			const now = new Date();
			const { body } = composeBody(text);
			const created = await admitted(
				(async () => {
					for (let attempt = 0; ; attempt++) {
						const result = await table.create(
							{
								fields: {
									capturedAt: now.toISOString() as CaptureFields['capturedAt'],
								},
								body,
							},
							{ stem: newStem(now) },
						);
						// Another capture took this name: a new one is tried.
						if (result.error?.name !== 'Exists' || attempt >= 3) return result;
					}
				})(),
			);
			if (created.error !== null)
				return `The capture was not saved: ${describeError(created.error)} Your text is still here.`;
			if (newCapture === text) newCapture = '';
			await refresh();
			const stem = rowStemOf(CAPTURES_TABLE, created.data.path);
			if (stem !== undefined) await open(stem, 'capture');
			return undefined;
		},

		/**
		 * Delete the open capture, whose session is `session`. The session is
		 * released and its last saves land first, so the delete removes what
		 * this window saved last; a file another program changed since is
		 * refused, and the capture opens again as it is now.
		 */
		async remove(
			session: RowSession<CaptureFields> | TextSession,
		): Promise<string | undefined> {
			const why = refused();
			if (why !== undefined) return why;
			const item = opened;
			if (item === undefined || sessionOf(item) !== session) return undefined;
			// Admitted whole, before its first await, so a departure and close
			// wait for the saves it waits on and for the delete itself.
			return admitted(
				(async () => {
					session.release();
					const { file } = await session.settled();
					const { error } = await table.delete(file);
					if (error === null) {
						if (opened === item) forget();
						await refresh();
						return undefined;
					}
					if (opened === item)
						await open(item.stem, item.kind === 'text' ? 'text' : 'capture', {
							discard: session,
						});
					return describeError(error);
				})(),
			);
		},

		/** Import a whole export, including its report and receipt, then list again. */
		async importLegacy(bundle: LegacyBundle): Promise<ImportReport> {
			const why = refused();
			if (why !== undefined) throw new Error(why);
			try {
				return await admitted(runLegacyImport(folder.files, bundle));
			} finally {
				await refresh();
			}
		},
		commit: () => folder.git.commit(),

		/**
		 * The page's part in leaving Epicenter. `fence` runs before anything is
		 * awaited; `settle` lets running actions and saves finish and answers
		 * how many things would be lost; `resume` gives everything back.
		 */
		departure: {
			fence() {
				departing = true;
			},
			async settle(): Promise<number> {
				await quiet();
				const item = opened;
				const settled = await sessionOf(item)?.settled();
				return (
					(holdsUnsaved(item, settled?.status) ? 1 : 0) +
					(newCapture === '' ? 0 : 1)
				);
			},
			resume() {
				departing = false;
			},
		},

		/**
		 * Let running actions and the open capture's saves finish before the
		 * page releases its folder. A failed save is not sent again. Every call
		 * answers the same completion.
		 */
		close(): Promise<void> {
			if (closing !== undefined) return closing;
			closing = (async () => {
				await quiet();
				const session = sessionOf(opened);
				const settled = await session?.settled();
				session?.release();
				if (settled?.status === 'error')
					log.warn(
						new Error(
							`Closed with a capture that could not be saved: ${settled.file.path}`,
						),
					);
			})();
			return closing;
		},
	};
}
