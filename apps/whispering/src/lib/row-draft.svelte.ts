/**
 * The app's policy over one folder row editor.
 *
 * The folder's editor (`table.edit`) owns the row: its local document, the
 * baseline that document is compared with, what the latest read found, and
 * every save's outcome. Nothing here copies those. This adds what the folder
 * leaves to the application: when to save, what typing is admitted, and what
 * the person is asked to review.
 *
 * - Typing saves after a short pause, while autosave runs and nothing is in
 *   question. A save writes the whole document whatever the file holds, so
 *   nothing is saved on its own while the latest read differs from the
 *   baseline, the file is gone or does not read as a row, or the document has
 *   issues.
 * - A save that failed, threw, or whose reply never arrived stops saving on
 *   its own until the person saves again or takes the file as it is now. A
 *   later read that finds the same text makes the draft clean, and the save
 *   it came from stays unknown: it is never reported as saved, and the draft
 *   still holds the close and its source until the person chooses.
 * - Typing during a save stays in the draft and is saved after it.
 * - While its file is moved or deleted, a draft writes nothing (`writes`).
 */
import type {
	FolderFiles,
	RowChange,
	RowEditor,
	RowEditorState,
	RowObservation,
	RowRevision,
	RowSaveOutcome,
} from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	type Admits,
	type Autosave,
	conflictCopyPath,
	TYPING_BATCH_MS,
} from './editor.svelte.js';

/**
 * What the latest read says about a draft with unsaved typing, when it is not
 * the file the typing was made on. Each stops saving on its own.
 */
type RowReview =
	/** The file holds another version of the row. */
	| { readonly kind: 'changed'; readonly current: RowRevision }
	/** The file is gone. */
	| { readonly kind: 'removed' }
	/** The file could not be read. */
	| { readonly kind: 'unreadable'; readonly message: string }
	/** The file no longer reads as a row. `source` is its exact text. */
	| {
			readonly kind: 'unrecognized';
			readonly message: string;
			readonly source: string;
	  };

/** One line about a draft's save, most pressing first. */
type RowDraftStatus =
	| { readonly kind: 'saved' }
	| { readonly kind: 'unsaved' }
	| { readonly kind: 'saving' }
	/** The typing has issues, so a save would write nothing. */
	| { readonly kind: 'invalid'; readonly message: string }
	| RowReview
	/**
	 * The latest save failed, or its reply never arrived. `inFile` is whether
	 * a read since found the file holding the draft: the save is still not
	 * known to be what put it there.
	 */
	| {
			readonly kind: 'failed' | 'unconfirmed';
			readonly message: string;
			readonly inFile: boolean;
	  };

const describeIssues = (reading: RowEditorState<unknown>['reading']) =>
	reading.parseError !== undefined
		? reading.parseError.message
		: reading.issues.map((issue) => issue.message).join('; ');

export function createRowDraft<TFields>(
	editor: RowEditor<TFields>,
	{
		files,
		autosave,
		admits,
		writes = () => true,
		onSaved,
		onIdleUnfollowable,
	}: {
		files: Pick<FolderFiles, 'create'>;
		autosave: Autosave;
		admits: Admits;
		/**
		 * Whether this draft may write its file now. False while the file is
		 * being moved or deleted: nothing is saved, by a timer, by settling, or
		 * by the person, until it is true again and `resume` is called.
		 */
		writes?: () => boolean;
		/** A save landed: the folder changed. */
		onSaved: () => void;
		/**
		 * The draft is clean and its file is gone or no longer reads as a row:
		 * nothing typed is lost by putting it down.
		 */
		onIdleUnfollowable: () => void;
	},
) {
	let state = $state.raw<RowEditorState<TFields>>(editor.get());
	/** Why the latest change was refused; the next accepted change clears it. */
	let refusal = $state<string | undefined>();
	/**
	 * A save that threw instead of answering. Storage reports failures as
	 * results, so this is a bug; it is kept so it is shown and saving stops.
	 */
	let thrown = $state<string | undefined>();
	/**
	 * The read current when the latest save receipt arrived. It describes the
	 * file before that save, so it is not another writer's change; the reread
	 * every save is followed by replaces it.
	 */
	let beforeReceipt: RowObservation<TFields> | undefined;
	/** A failed or unknown save the person has since resolved by choosing a version. */
	let settledOutcome = $state.raw<RowSaveOutcome | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let announcedUnfollowable = false;

	/**
	 * What the latest read says against the baseline, when the person has
	 * something there to decide: unsaved typing, or a save that failed or was
	 * never answered. A clean draft with nothing in question just follows.
	 */
	function review(current = state): RowReview | undefined {
		if (!current.isDirty && !stopped(current)) return undefined;
		const { observation } = current;
		if (observation === beforeReceipt) return undefined;
		switch (observation.kind) {
			case 'present':
				return observation.revision.sha256 === current.baseline.sha256
					? undefined
					: { kind: 'changed', current: observation.revision };
			case 'missing':
				return { kind: 'removed' };
			case 'unreadable':
				return { kind: 'unreadable', message: observation.error.message };
			case 'unsupported':
				return {
					kind: 'unrecognized',
					message: observation.refusal.reason,
					source: observation.file.source,
				};
			case 'invalid':
				return {
					kind: 'unrecognized',
					message: describeIssues(observation.reading),
					source: observation.file.source,
				};
			default:
				return observation satisfies never;
		}
	}

	/** Whether the latest save left saving to the person: it failed, threw, or never answered. */
	function stopped(current = state) {
		const last = current.lastSave;
		return (
			thrown !== undefined ||
			(last !== undefined && last.kind !== 'saved' && last !== settledOutcome)
		);
	}

	const isValid = (current = state) =>
		current.reading.parseError === undefined &&
		current.reading.issues.length === 0;

	/** Whether unsaved typing can be saved without the person deciding anything. */
	function settles(current = state) {
		return (
			current.isDirty &&
			!current.isDisposed &&
			!stopped(current) &&
			review(current) === undefined &&
			isValid(current) &&
			writes()
		);
	}

	const autosaves = () =>
		settles() && state.saving === undefined && !autosave.paused && admits();

	function schedule() {
		clearTimeout(timer);
		timer = undefined;
		if (!autosaves()) return;
		timer = setTimeout(() => {
			timer = undefined;
			if (autosaves()) void save();
		}, TYPING_BATCH_MS);
	}

	const stop = editor.subscribe((next) => {
		if (next.lastSave !== state.lastSave && next.lastSave?.kind === 'saved')
			beforeReceipt = next.observation;
		state = next;
		// A hold that cleared, such as the reread after a save, resumes saving.
		if (timer === undefined && saving === undefined && autosaves()) schedule();
		// Only a draft that holds nothing is offered back. A save in question
		// keeps the draft, and what the read found stays as its review.
		const unfollowable =
			!next.isDirty &&
			!stopped(next) &&
			next.saving === undefined &&
			!next.isDisposed &&
			next.observation.kind !== 'present' &&
			next.observation.kind !== 'unreadable';
		if (unfollowable && !announcedUnfollowable) {
			announcedUnfollowable = true;
			queueMicrotask(onIdleUnfollowable);
		}
		if (!unfollowable) announcedUnfollowable = false;
	});

	/** Save the document now, once. Resolves when that save has settled. */
	async function save(): Promise<void> {
		clearTimeout(timer);
		timer = undefined;
		if (saving !== undefined) return saving;
		if (state.isDisposed || !writes()) return;
		const run = (async () => {
			thrown = undefined;
			try {
				const { error: saveError } = await editor.save();
				if (saveError === null) onSaved();
			} catch (cause) {
				thrown = cause instanceof Error ? cause.message : String(cause);
			}
		})();
		saving = run;
		try {
			await run;
		} finally {
			saving = undefined;
		}
		// Typing that arrived during the save is still unsaved; batch it again.
		if (autosaves()) schedule();
	}

	/** The person chose a version: an earlier failed or unknown save no longer stops saving. */
	function settleOutcome() {
		if (state.lastSave?.kind !== 'saved') settledOutcome = state.lastSave;
		thrown = undefined;
	}

	return {
		get path() {
			return state.path;
		},
		/** The folder editor's state: the local document, baseline, latest read, and last save. */
		get state() {
			return state;
		},
		get isDirty() {
			return state.isDirty;
		},
		/** Why the latest change was refused; the document is unchanged. */
		get refusal() {
			return refusal;
		},
		/** What the latest read says about unsaved typing, when it needs the person. */
		get review() {
			return review();
		},
		/**
		 * Why the latest save is not known to have landed, kept after the
		 * person took the file as it is now, until a later save is confirmed.
		 * A file that holds the same text does not answer it.
		 */
		get unknown() {
			const last = state.lastSave;
			return last?.kind === 'unconfirmed' ? last.error.message : undefined;
		},
		get status(): RowDraftStatus {
			if (state.saving !== undefined) return { kind: 'saving' };
			const held = review();
			if (held !== undefined) return held;
			if (thrown !== undefined)
				return { kind: 'failed', message: thrown, inFile: !state.isDirty };
			const last = state.lastSave;
			if (
				last !== undefined &&
				last.kind !== 'saved' &&
				last !== settledOutcome
			)
				return {
					kind: last.kind,
					message: last.error.message,
					inFile: !state.isDirty,
				};
			if (!state.isDirty) return { kind: 'saved' };
			if (!isValid())
				return { kind: 'invalid', message: describeIssues(state.reading) };
			return { kind: 'unsaved' };
		},
		/**
		 * Whether the draft holds something the person has not settled: typing
		 * not saved, a save still out, or a save that failed, threw, or was
		 * never answered and that they have not tried again or replaced by
		 * taking the file as it is. Clean typing does not release it. While it
		 * holds, leaving asks first, its source is not taken over, and it
		 * writes nothing on its own.
		 */
		get holds() {
			return state.isDirty || state.saving !== undefined || stopped();
		},
		/**
		 * Change named fields or the body. Refused while new work is not
		 * admitted, and for a value with no canonical form; the document is
		 * then unchanged.
		 */
		change(next: RowChange<TFields>): boolean {
			if (!admits()) return false;
			const { error: changeError } = editor.change(next);
			if (changeError !== null) {
				refusal = changeError.message;
				return false;
			}
			refusal = undefined;
			schedule();
			return true;
		},
		/**
		 * Take typing the draft of this file at its old path already accepted,
		 * when the file moved here. It is not new input, so admission does not
		 * gate it: while the page decides whether to close, typing that was
		 * taken before must not be dropped on its way to the new path.
		 */
		carry(next: RowChange<TFields>): boolean {
			const { error: changeError } = editor.change(next);
			if (changeError !== null) {
				refusal = changeError.message;
				return false;
			}
			schedule();
			return true;
		},
		/** Save the whole document now, as the person asked, whatever stopped saving before. */
		async saveNow() {
			if (!admits()) return;
			await save();
		},
		/** Read the file again now. */
		refresh: () => editor.refresh(),
		/**
		 * Take the file as the latest read found it, in place of the typing: the
		 * other version under review, or, after a save that failed or was never
		 * answered, the file as it is now, clean or not. That releases the
		 * draft; the last save's own outcome stays what it was.
		 */
		takeCurrent(): Result<undefined, string> {
			if (!admits())
				return Err('Whispering is closing, so nothing was changed.');
			const held = review();
			const { observation } = state;
			const current =
				held?.kind === 'changed'
					? held.current
					: held === undefined && stopped() && observation.kind === 'present'
						? observation.revision
						: undefined;
			if (current === undefined)
				return Err('There is no version of this file to take.');
			const { error: adoptError } = editor.adopt(current);
			if (adoptError !== null) return Err(adoptError.message);
			settleOutcome();
			return Ok(undefined);
		},
		/** Saving may go on again after writes were held: batch held typing. */
		resume() {
			if (timer === undefined && saving === undefined) schedule();
		},
		/**
		 * Write the typing to a new file beside the row, under `conflicts/`.
		 * Returns the copy's path. The draft itself is unchanged.
		 */
		async keepCopy(): Promise<Result<string, string>> {
			if (!admits())
				return Err('Whispering is closing, so nothing was written.');
			const copy = conflictCopyPath(state.path);
			const { error: createError } = await files.create(copy, state.source);
			if (createError !== null) return Err(createError.message);
			return Ok(copy);
		},
		/**
		 * Save typing that can be saved without a decision, then report whether
		 * the draft holds nothing more. Typing that waits on the person (a
		 * failed or unknown save, another version, issues) is left for them,
		 * and so is an unresolved save whose text the file already holds.
		 */
		async settle(): Promise<boolean> {
			clearTimeout(timer);
			timer = undefined;
			for (;;) {
				if (saving !== undefined) {
					await saving;
					continue;
				}
				if (!settles()) break;
				await save();
				if (stopped()) break;
			}
			return !state.isDirty && review() === undefined && !stopped();
		},
		/** Stop saving and watching. A save already sent still settles first. */
		dispose(): Promise<void> {
			clearTimeout(timer);
			timer = undefined;
			// A save that threw rejects disposal with the same error; it is already
			// kept as this draft's failure, so disposal itself always settles.
			return editor
				.dispose()
				.catch(() => undefined)
				.finally(stop);
		},
	};
}

export type RowDraft<TFields> = ReturnType<typeof createRowDraft<TFields>>;
