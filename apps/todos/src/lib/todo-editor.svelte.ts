/**
 * The todo editor: one retained, structured draft of one todo row.
 *
 * The folder's row editor (`table.edit`) owns the draft: the local document,
 * the baseline it is compared against, the latest read of the file, and each
 * save attempt. Every save writes the complete canonical document over the
 * row's path, whatever the file holds. Nothing is conditional: a save after
 * another writer replaces their text, and a save after a removal writes the
 * row again. The title, done, and notes controls, and a toggle from the list,
 * all change this one draft.
 *
 * This module is the app's policy around that draft:
 *
 * - Autosave. A change saves after a short pause, one save at a time, while
 *   the draft is unsaved and its fields conform. A draft whose fields do not
 *   conform keeps its input on screen and is not saved.
 * - Halting. A save that failed, or whose reply was lost, stops autosave
 *   until the person saves explicitly. A lost reply stays unknown even when a
 *   later read finds the same text: that read cannot say who wrote it.
 * - Review. While the draft has unsaved input and the latest read shows a
 *   change this editor did not make (other bytes, a removal, a read that
 *   failed, or text that no longer reads as a todo), nothing saves on its
 *   own: no timer, settle, rename, delete, or close writes over what the
 *   person has not seen. The hold ends with their choice: save mine, which
 *   writes the whole draft over it or writes the row again, or discard mine.
 *   A clean draft still follows a valid read on its own. The read that
 *   predates this editor's own successful save is not a change made
 *   elsewhere; the reread that follows the save replaces it.
 * - Rename. A row editor is fixed to its path. A rename saves the draft,
 *   holds saves, moves the file, opens a row editor at the destination,
 *   carries over what was typed meanwhile, and disposes the old editor, so
 *   nothing is ever written at the path the row left. A move that landed
 *   its destination but kept its source leaves the draft at the source, which
 *   still holds the row. A move whose reply was lost halts autosave, since
 *   the row may already have left the path this editor writes.
 * - Delete. A delete holds saves too, after any running save finishes, so
 *   no save of this draft lands during it. A delete whose reply was lost, or
 *   that threw, halts the editor before the owner lets the path go, clean or
 *   not: nothing saves on its own, and no later read, of the row or of its
 *   absence, answers it. A delete that removed the row while input arrived
 *   halts the same way, so that input never writes the row back on its own.
 *   The person's explicit save writes the row (again); discarding drops it.
 *
 * Git outcomes never touch this state. The owner (`todos.svelte.ts`) decides
 * when an editor is retained and disposes it when it forgets the path or
 * closes.
 */
import {
	FileError,
	type FileTable,
	type RowChange,
	type RowEditor,
	type RowEditorState,
	type RowRevision,
	type RowSaveError,
	rowPath,
	rowStemOf,
	type TableEditError,
	type TableRenameError,
	type TextCapture,
} from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';
import type { TodoFields } from './definition.js';
import { TYPING_BATCH_MS } from './editor.svelte.js';

export type TodoEditorState = RowEditorState<TodoFields>;

/**
 * Why autosave stopped, until the person's explicit save or discard. An
 * `unknown` outcome may or may not have reached the file: a save's bytes, a
 * rename's move, or a delete's removal. `deleted` is a delete that removed
 * the row while input arrived.
 */
export type SaveHalt =
	| {
			readonly kind: 'failed' | 'unknown';
			readonly operation: 'save' | 'rename' | 'delete';
			readonly message: string;
	  }
	| {
			readonly kind: 'deleted';
			readonly operation: 'delete';
			readonly message: string;
	  };

/** Where a rename left the row. */
export type Moved = {
	/**
	 * The reviewed baseline, named at the new path. The move was guarded by
	 * its hash at the old path; nothing read the destination, and a native
	 * folder checks that guard only as well as other programs allow. So this
	 * is what the person reviewed, not verified bytes at the new path; the
	 * editor reopened there reads what the file holds.
	 */
	readonly row: TextCapture;
	/**
	 * Set when the destination did not open as a structured todo. The editor
	 * is disposed; `typed` is its unsaved text, if any, for the owner to keep.
	 */
	readonly unopened?: {
		readonly error: TableEditError;
		readonly typed: string | undefined;
	};
};

/** Whether the draft's fields conform, so its save would be admitted. */
export function conforms(state: TodoEditorState): boolean {
	return (
		state.reading.parseError === undefined && state.reading.issues.length === 0
	);
}

/** What a person is told when a row editor did not open. */
export function describeEditError(error: TableEditError): string {
	switch (error.name) {
		case 'NotFound':
			return 'This todo is no longer in the folder.';
		case 'NoCanonicalForm':
			return `This todo's text cannot be edited as fields: ${error.refusal.reason}. Fix it in its source.`;
		case 'InvalidSource':
			return 'This todo needs repair before its fields can be edited. Fix it in its source.';
		case 'Aborted':
			return 'Opening this todo was cancelled.';
		default:
			return error.message;
	}
}

/** What a person is told when a save did not happen or may not have. */
export function describeSaveError(error: RowSaveError): string {
	switch (error.name) {
		case 'InvalidDocument':
			return 'Some fields need fixing, so this todo was not saved.';
		case 'Saving':
			return 'A save of this todo is already running.';
		case 'Disposed':
			return 'This todo is closed, so it was not saved.';
		case 'Unconfirmed':
			return 'The save was sent, but its reply was lost, so it may or may not be in the file.';
		default:
			return error.message;
	}
}

export function createTodoEditor(
	table: FileTable<TodoFields>,
	opened: RowEditor<TodoFields>,
	onSaved: () => void,
) {
	let row = opened;
	let state = $state.raw<TodoEditorState>(opened.get());
	/**
	 * The latest read when this editor's last save succeeded. The row editor
	 * keeps it until the reread that follows the save, so it may describe the
	 * bytes that save replaced; it is never a change made elsewhere.
	 */
	let superseded = $state.raw<TodoEditorState['observation'] | undefined>();
	let halt = $state.raw<SaveHalt | undefined>();
	/** Why the last change was refused; the next accepted change clears it. */
	let refusal = $state<string | undefined>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * The save this editor started, until its outcome is applied. Reactive:
	 * it is cleared after the row editor's last state of the save, so a view
	 * reading `isSaving` or `isIdle` must hear the clearing itself.
	 */
	let saving = $state.raw<Promise<string | undefined> | undefined>();
	/** Pending while a rename owns the row's path; resolves when it settles. */
	let moving: Promise<void> | undefined;

	/**
	 * Take the row editor's next state, noting each save of ours that it
	 * settles. Input held for review saves on its own again once a read no
	 * longer shows the change, as when the other writer puts it back.
	 */
	function receive(next: TodoEditorState) {
		const wasAwaitingReview = isAwaitingReview();
		if (next.lastSave !== state.lastSave && next.lastSave?.kind === 'saved')
			superseded = next.observation;
		state = next;
		if (wasAwaitingReview && canSaveOnItsOwn()) schedule();
	}

	const isIdle = () =>
		!state.isDirty && saving === undefined && halt === undefined;

	/**
	 * The latest read, when it shows a change this editor did not make: other
	 * bytes than the baseline, no file, a failed read, or text that is not a
	 * valid todo.
	 */
	function externalChange() {
		const { observation, baseline } = state;
		if (observation === superseded) return undefined;
		if (
			observation.kind === 'present' &&
			observation.revision.sha256 === baseline.sha256
		)
			return undefined;
		return observation;
	}

	/** Unsaved input waits for the person to review a change made elsewhere. */
	const isAwaitingReview = () =>
		state.isDirty && externalChange() !== undefined;

	/** Whether input may save without the person asking. */
	const canSaveOnItsOwn = () =>
		state.isDirty &&
		halt === undefined &&
		conforms(state) &&
		!isAwaitingReview() &&
		!state.isDisposed;

	// Subscribed once everything `receive` reads exists: it runs at once.
	let unsubscribe = row.subscribe(receive);

	/** Follow another row editor; the previous one is the caller's to dispose. */
	function bind(next: RowEditor<TodoFields>) {
		unsubscribe();
		row = next;
		superseded = undefined;
		unsubscribe = next.subscribe(receive);
	}

	function schedule() {
		clearTimeout(timer);
		if (halt !== undefined || moving || state.isDisposed) return;
		timer = setTimeout(() => {
			if (saving === undefined && !moving && canSaveOnItsOwn()) void run();
		}, TYPING_BATCH_MS);
	}

	/** One save of the document as it is now. Answers why it did not save. */
	async function attempt(): Promise<string | undefined> {
		// Every attempt is a renewed one; only its own outcome can halt again.
		halt = undefined;
		let saved: Result<RowRevision, RowSaveError>;
		try {
			saved = await row.save();
		} catch (cause) {
			// Storage that throws is a bug, but the draft must not stay saving.
			halt = {
				kind: 'failed',
				operation: 'save',
				message: cause instanceof Error ? cause.message : String(cause),
			};
			return halt.message;
		}
		if (saved.error === null) {
			onSaved();
			return undefined;
		}
		const { error } = saved;
		const message = describeSaveError(error);
		switch (error.name) {
			case 'InvalidDocument':
			case 'Saving':
			case 'Disposed':
				return message;
			default:
				halt = {
					kind: error.name === 'Unconfirmed' ? 'unknown' : 'failed',
					operation: 'save',
					message,
				};
				return message;
		}
	}

	/** Start a save once any running one has settled. */
	async function run(): Promise<string | undefined> {
		clearTimeout(timer);
		while (saving) await saving;
		const started = attempt();
		saving = started;
		try {
			return await started;
		} finally {
			if (saving === started) saving = undefined;
			// Input that arrived during the save is still unsaved; batch it again.
			if (state.isDirty) schedule();
		}
	}

	/**
	 * Save until nothing is left that may save on its own, or a save does not
	 * succeed. Input held for review stays unsaved.
	 */
	async function drain() {
		clearTimeout(timer);
		while (saving) await saving;
		while (canSaveOnItsOwn()) if ((await run()) !== undefined) return;
	}

	return {
		/** The row editor's state: draft, baseline, latest read, and save outcomes. */
		get state() {
			return state;
		},
		get path() {
			return state.path;
		},
		/** Set when a save failed or its outcome is unknown, until the next save starts. */
		get halt() {
			return halt;
		},
		get refusal() {
			return refusal;
		},
		/** Nothing is unsaved, saving, or halted. */
		get isIdle() {
			return isIdle();
		},
		get isSaving() {
			return saving !== undefined;
		},
		/**
		 * The latest read when it shows a change this editor did not make. A
		 * clean draft follows a valid one, so with input it is a review.
		 */
		get externalChange() {
			return externalChange();
		},
		/** Unsaved input waits for the person to save it over, or discard it for, a change made elsewhere. */
		get isAwaitingReview() {
			return isAwaitingReview();
		},
		/**
		 * The input cannot save on its own: a save halted, its fields do not
		 * conform, or it waits for review.
		 */
		get hasProblem() {
			return (
				halt !== undefined ||
				(state.isDirty && !conforms(state)) ||
				isAwaitingReview()
			);
		},
		/**
		 * The person may drop the draft: it cannot save on its own, or the
		 * file changed elsewhere. Discarding writes nothing.
		 */
		get isDiscardable() {
			return (
				halt !== undefined ||
				(state.isDirty && !conforms(state)) ||
				externalChange() !== undefined
			);
		},
		/**
		 * Change declared fields or the notes. The draft may stop conforming; it
		 * then is not saved, and keeps the input. Answers why a change was refused.
		 */
		change(requested: RowChange<TodoFields>): string | undefined {
			const changed = row.change(requested);
			if (changed.error !== null) {
				refusal =
					changed.error.name === 'Unrepresentable'
						? `This value cannot be saved: ${changed.error.refusal.reason}.`
						: 'This todo is closed, so the change was not applied.';
				return refusal;
			}
			refusal = undefined;
			schedule();
			return undefined;
		},
		/**
		 * Save the complete document now, after any running save. This is the
		 * person's explicit save: it renews autosave after a halt, and it is
		 * "save mine" in a review, writing the whole draft over a change made
		 * elsewhere or writing a removed row again. It saves a draft with
		 * nothing unsaved too. A rename holds saves: this returns at once, and
		 * the input saves at the destination. Answers why nothing was saved.
		 */
		async save(): Promise<string | undefined> {
			if (moving) return undefined;
			return run();
		},
		/** Read the file now; a clean draft follows it. */
		refresh() {
			return row.refresh();
		},
		/**
		 * Discard the local draft and take the file as the latest read found
		 * it. Nothing is written. Answers why it was refused.
		 */
		adopt(): string | undefined {
			const latest = state.observation;
			if (latest.kind !== 'present')
				return 'There is no saved version to load.';
			const adopted = row.adopt(latest.revision);
			if (adopted.error !== null)
				return adopted.error.name === 'Stale'
					? 'The file changed again. Review it and try again.'
					: describeSaveError(adopted.error);
			clearTimeout(timer);
			// A read of the row cannot answer what a delete did; only an
			// explicit save or discard ends that halt.
			if (halt?.operation !== 'delete') halt = undefined;
			refusal = undefined;
			return undefined;
		},
		/**
		 * Save pending input before a delete, a switch to the source editor, or
		 * close. Waits for a running rename first. True when nothing is left
		 * unsaved, saving, or halted.
		 */
		async settle(): Promise<boolean> {
			while (moving) await moving;
			await drain();
			return isIdle();
		},
		/**
		 * Rename the row to `nextStem`: a conditional table move of the file as
		 * this editor last read or saved it.
		 *
		 * Pending input saves first, and no save starts until the editor is at
		 * the destination, so nothing is written at the path the row leaves.
		 * Changes are accepted throughout; those made during the move are
		 * carried to the destination's editor and save there.
		 *
		 * On a refusal this editor stays at its path, which still holds the
		 * row, and its input saves there. `SourceNotRemoved` is such a case:
		 * the destination landed too, and both files stay as they are. An
		 * `Unconfirmed` move may have taken the row away, so it halts autosave
		 * as an unknown outcome; the input stays until the person saves.
		 * Nothing is retried or removed.
		 *
		 * Returns `undefined` without moving when the input could not be saved
		 * first or another rename is running.
		 */
		async move(
			nextStem: string,
		): Promise<Result<Moved, TableRenameError> | undefined> {
			if (moving) return undefined;
			const settled = Promise.withResolvers<void>();
			moving = settled.promise;
			try {
				await drain();
				// The move captures the file as it is now; a clean draft follows it.
				await row.refresh();
				if (!isIdle()) return undefined;
				const { baseline } = state;
				const stem = rowStemOf(table.name, baseline.path);
				if (stem === undefined) return undefined;
				const renamed = await table.rename(stem, nextStem, {
					expectedSha256: baseline.sha256,
				});
				if (renamed.error !== null) {
					if (renamed.error.name === 'Unconfirmed')
						halt = {
							kind: 'unknown',
							operation: 'rename',
							message:
								'The rename was sent, but its reply was lost, so this todo may now be at either name. Your edits stay here until you save them.',
						};
					return renamed;
				}
				// The reviewed baseline at its new address. The guard was checked
				// at the old path; this is not a read of the destination.
				const destination: TextCapture = Object.freeze({
					path: rowPath(table.name, nextStem),
					sha256: baseline.sha256,
					text: baseline.text,
				});
				const reopened = await table.edit(nextStem);
				// The retired editor's draft, with every change made during the move.
				const typed = state;
				const retired = row;
				if (reopened.error !== null) {
					await retired.dispose();
					return Ok({
						row: destination,
						unopened: {
							error: reopened.error,
							typed: typed.isDirty ? typed.text : undefined,
						},
					});
				}
				bind(reopened.data);
				if (typed.isDirty) {
					const { title, done } = typed.document.fields;
					reopened.data.change({
						fields: { title, done },
						body: typed.document.body,
					});
				}
				await retired.dispose();
				return Ok({ row: destination });
			} finally {
				moving = undefined;
				settled.resolve();
				if (state.isDirty) schedule();
			}
		},
		/**
		 * Hold saves while `work` runs, as when an incoming update is recovered
		 * and may write this row. A save already running finishes first, and
		 * none starts until `work` settles. Changes are accepted throughout.
		 * Before the hold lifts, the row is read again, so a row `work` changed
		 * is the latest read: a clean draft follows it, and input waits for the
		 * person's review instead of saving over it.
		 */
		async hold<T>(work: () => Promise<T>): Promise<T> {
			while (moving) await moving;
			const settled = Promise.withResolvers<void>();
			moving = settled.promise;
			try {
				clearTimeout(timer);
				while (saving) await saving;
				const done = await work();
				await row.refresh();
				return done;
			} finally {
				moving = undefined;
				settled.resolve();
				if (state.isDirty) schedule();
			}
		},
		/**
		 * Delete the row. `run` removes the version the person confirmed. A save
		 * already running finishes first, and none starts until `run` answers,
		 * so no save of this draft lands during the delete. Changes are
		 * accepted throughout.
		 *
		 * The outcome is recorded before this returns, so before the owner lets
		 * the path go. A delete whose reply was lost, or that threw, halts this
		 * editor as unknown whether or not it holds input. A delete that removed
		 * the row while input arrived halts it as deleted. Either way nothing
		 * saves on its own, and no read ends the halt: the person's explicit
		 * save writes the row (again), or they discard the draft. A refusal
		 * removed nothing, and input saves as usual.
		 *
		 * Returns `undefined` without running while input is unsaved or halted,
		 * or another rename or delete is running.
		 */
		async remove(
			run: () => Promise<Result<undefined, FileError>>,
		): Promise<Result<undefined, FileError> | undefined> {
			if (moving) return undefined;
			const settled = Promise.withResolvers<void>();
			moving = settled.promise;
			try {
				clearTimeout(timer);
				while (saving) await saving;
				if (!isIdle()) return undefined;
				let removed: Result<undefined, FileError>;
				try {
					removed = await run();
				} catch (cause) {
					removed = FileError.Unconfirmed({
						path: state.path,
						operation: 'remove',
						cause,
					});
				}
				if (removed.error?.name === 'Unconfirmed')
					halt = {
						kind: 'unknown',
						operation: 'delete',
						message:
							'The delete was sent, but its reply was lost, so this todo may or may not still be in the folder.',
					};
				else if (removed.error === null && state.isDirty)
					halt = {
						kind: 'deleted',
						operation: 'delete',
						message: 'This todo was deleted while you were editing it.',
					};
				return removed;
			} finally {
				moving = undefined;
				settled.resolve();
				if (state.isDirty) schedule();
			}
		},
		/**
		 * Stop watching the file and refuse input. A running save still settles
		 * first. Never rejects: a save whose storage threw already reported that
		 * to its own call, which recorded the halt.
		 */
		async dispose(): Promise<void> {
			clearTimeout(timer);
			await row.dispose().catch(() => undefined);
		},
	};
}

export type TodoEditor = ReturnType<typeof createTodoEditor>;
