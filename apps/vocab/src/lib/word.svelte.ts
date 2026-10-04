/**
 * One saved word: who owns its text, and every piece of work on its file.
 *
 * Exactly one owner holds the word's text at a time:
 *
 * - `editing`: the folder's row editor, holding the note while it is typed
 *   and the stage in one local document, its baseline, the latest read, and
 *   each save. A save writes the whole word, note and stage together,
 *   whatever the file holds, and a note typed during it stays unsaved against
 *   its receipt.
 * - `repair`: the exact text of a file that cannot open as a row, as this
 *   page holds it. No editor runs. A repair replaces only the version of the
 *   file that was shown, and only when the learner saves it.
 *
 * The editor opens on first use, not for the whole list. Opening, every save,
 * every repair, and deletion run on one tracked chain, one at a time.
 * Deletion and disposal close a gate first, so no view of the word starts new
 * work, then wait for the chain.
 *
 * - The note saves on leaving its field. A stage saves on pressing it, with
 *   the note as typed, so neither control resets the other. Leaving the field
 *   while the editor is still opening saves once it has opened.
 * - Leaving the field does not save, and a stage is refused, while the word
 *   holds other content than the note was typed over, or the file is not a
 *   valid word or cannot be read. The learner keeps theirs, takes the saved
 *   word, or repairs the file's text.
 * - A failed save, or one whose answer was lost, is not sent again by leaving
 *   the field; it stays shown, unknown when unknown. Trying again sends the
 *   word again. Taking the saved word answers that outcome without calling it
 *   saved, so later typing saves as usual.
 */
import type {
	RowRevision,
	RowSaveOutcome,
	TableEditError,
	TextCapture,
} from '@epicenter/folder';
import { extractErrorMessage } from 'wellcrafted/error';
import { type Entry, readEntry, type Stage, type VocabTables } from './data.js';

type EntriesTable = VocabTables['entries'];
type WordEditor = NonNullable<
	Awaited<ReturnType<EntriesTable['edit']>>['data']
>;
type WordState = ReturnType<WordEditor['get']>;

type WordMode =
	| { readonly kind: 'closed' }
	| { readonly kind: 'opening' }
	| { readonly kind: 'editing'; readonly editor: WordEditor }
	| {
			readonly kind: 'repair';
			/** The file's exact text as the learner was shown it; a repair replaces only this. */
			readonly file: TextCapture;
			/** The repair text, as typed here. */
			readonly text: string;
			readonly reason: string;
			/** Why the last repair did not land. */
			readonly problem: string | undefined;
	  }
	/** No editor could be opened: the word is gone or cannot be read. */
	| { readonly kind: 'unavailable'; readonly message: string };

/** A save of this word that did not land, or whose answer was lost. */
type WordOutcome =
	| { readonly kind: 'unconfirmed'; readonly message: string }
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * A delete was sent and no answer came back: the word may be gone. A later
	 * read showing it present or gone confirms nothing about the delete.
	 */
	| { readonly kind: 'deletion'; readonly message: string };

/** What the latest read of the file asks the learner to review first. */
type WordReview =
	/** The note is unsaved and the word holds other content than it was typed over. */
	| {
			readonly kind: 'changed';
			readonly revision: RowRevision;
			readonly note: unknown;
	  }
	/** The file was changed into something that is not a valid word. */
	| {
			readonly kind: 'invalid';
			readonly file: TextCapture;
			readonly message: string;
	  }
	/** The file cannot be read, so nothing may be saved over it. */
	| { readonly kind: 'unreadable'; readonly message: string };

/**
 * The last save's outcome while the learner has not answered it. History:
 * `acknowledged` is an outcome they answered by taking the saved word; it
 * stays the editor's `lastSave` and only stops being shown.
 */
function wordOutcome(
	state: WordState,
	{
		acknowledged,
		thrown,
	}: { acknowledged: RowSaveOutcome | undefined; thrown: string | undefined },
): WordOutcome | undefined {
	if (thrown !== undefined) return { kind: 'failed', message: thrown };
	const lastSave = state.lastSave === acknowledged ? undefined : state.lastSave;
	if (lastSave?.kind === 'failed' || lastSave?.kind === 'unconfirmed')
		return { kind: lastSave.kind, message: lastSave.error.message };
	return undefined;
}

/**
 * What the latest read asks the learner to review before anything saves,
 * whatever any earlier save's outcome was. A word removed elsewhere asks
 * nothing: the next save writes it back.
 */
function wordReview(
	state: WordState,
	{ working }: { working: boolean },
): WordReview | undefined {
	const { observation, isDirty, baseline } = state;
	switch (observation.kind) {
		case 'present':
			// A read from before this page's own save settled is not news.
			if (working || state.saving !== undefined) return;
			return isDirty && observation.revision.canonical !== baseline.canonical
				? {
						kind: 'changed',
						revision: observation.revision,
						note: observation.revision.document.fields.note,
					}
				: undefined;
		case 'unreadable':
			return { kind: 'unreadable', message: observation.error.message };
		case 'unsupported':
			return {
				kind: 'invalid',
				file: observation.file,
				message: observation.refusal.reason,
			};
		case 'invalid':
			return {
				kind: 'invalid',
				file: observation.file,
				message:
					observation.reading.parseError?.message ??
					observation.reading.issues.map((issue) => issue.message).join('; '),
			};
		// A word removed elsewhere is written back by the next save.
		case 'missing':
			return;
		default:
			return observation satisfies never;
	}
}

const captureOf = ({ path, sha256, source }: TextCapture): TextCapture => ({
	path,
	sha256,
	source,
});

const noop = () => {};

export type WordDraft = ReturnType<typeof createWordDraft>;

export function createWordDraft({
	table,
	id,
	onSaved,
}: {
	table: EntriesTable;
	id: string;
	/** A save or a repair reached the folder: this is the word it wrote. */
	onSaved: (entry: Entry) => void;
}) {
	let mode = $state.raw<WordMode>({ kind: 'closed' });
	/** The editor's state, only while the editor owns the text. */
	let state = $state.raw<WordState | undefined>();
	/** A note typed while no editor holds it, applied once one does. */
	let pendingNote = $state<string | undefined>();
	/** How many tracked operations are queued or running. */
	let working = $state(0);
	/** The folder threw instead of answering a save. */
	let thrown = $state<string | undefined>();
	/** A delete of this word was not answered; held until the learner chooses. */
	let deletion = $state<string | undefined>();
	let acknowledged = $state.raw<RowSaveOutcome | undefined>();
	/** Deletion or disposal is under way: no view starts new work. */
	let gated = $state(false);
	/** Disposal began: an editor opened from now on is let go at once. */
	let retired = false;
	let tail: Promise<void> | undefined;
	let disposal: Promise<void> | undefined;

	/**
	 * Run `operation` after every operation before it. With nothing pending it
	 * starts now, so a save captures the word as it is at the call.
	 */
	function track<T>(operation: () => Promise<T>): Promise<T> {
		working++;
		const start = async () => {
			try {
				return await operation();
			} finally {
				// The last one out leaves the chain idle before its caller resumes.
				if (--working === 0) tail = undefined;
			}
		};
		const result = tail === undefined ? start() : tail.then(start);
		tail = result.then(noop, noop);
		return result;
	}

	async function idle() {
		while (tail) await tail;
	}

	/** Why no new work starts, while the gate is closed. */
	const stopped = () =>
		retired
			? 'This page is closing, so nothing more is saved here.'
			: 'This word is being deleted.';
	const dirty = () => mode.kind === 'editing' && (state?.isDirty ?? false);
	const repairTyped = () =>
		mode.kind === 'repair' && mode.text !== mode.file.source;

	// Shown side by side, and each judged on its own: an old outcome never
	// hides what the latest read found, and what it found never hides that a
	// save did not land.
	const outcome = $derived(
		deletion !== undefined
			? ({ kind: 'deletion', message: deletion } as const)
			: mode.kind === 'editing' && state !== undefined
				? wordOutcome(state, { acknowledged, thrown })
				: undefined,
	);
	const review = $derived(
		mode.kind === 'editing' && state !== undefined
			? wordReview(state, { working: working > 0 })
			: undefined,
	);

	/** The word a save receipt wrote, read as the listing reads it. */
	function entryOf({ path, source, sha256 }: RowRevision): Entry | undefined {
		return readEntry({
			path,
			stem: id,
			source,
			sha256,
			...table.inspect(source),
		});
	}

	function attach(editor: WordEditor) {
		mode = { kind: 'editing', editor };
		thrown = undefined;
		acknowledged = undefined;
		editor.subscribe((next) => {
			// A former editor's last states are not news.
			if (mode.kind === 'editing' && mode.editor === editor) state = next;
		});
		if (pendingNote !== undefined) {
			const { error: changeError } = editor.change({
				fields: { note: pendingNote },
			});
			if (changeError === null) pendingNote = undefined;
		}
	}

	/** Hold a file that has no row form as repair text, keeping text typed here. */
	function holdRepair(file: TextCapture, reason: string) {
		const text =
			repairTyped() && mode.kind === 'repair' ? mode.text : file.source;
		mode = {
			kind: 'repair',
			file: captureOf(file),
			text,
			reason,
			problem: mode.kind === 'repair' ? mode.problem : undefined,
		};
	}

	function opened(error: TableEditError) {
		switch (error.name) {
			case 'NoCanonicalForm':
			case 'InvalidSource':
				holdRepair(error.file, error.message);
				return;
			default:
				if (repairTyped() && mode.kind === 'repair') {
					mode = { ...mode, problem: error.message };
					return;
				}
				mode = { kind: 'unavailable', message: error.message };
		}
	}

	/**
	 * Open an editor on the word as it is now. Part of a tracked operation.
	 * Repair text typed meanwhile keeps its owner: the new editor is let go.
	 */
	async function acquire(): Promise<void> {
		if (mode.kind === 'closed') mode = { kind: 'opening' };
		let result: Awaited<ReturnType<EntriesTable['edit']>>;
		try {
			result = await table.edit(id);
		} catch (cause) {
			if (retired) return;
			const message = extractErrorMessage(cause);
			if (repairTyped() && mode.kind === 'repair')
				mode = { ...mode, problem: message };
			else mode = { kind: 'unavailable', message };
			return;
		}
		const { data: editor, error: editError } = result;
		if (retired || repairTyped()) {
			if (editError === null) await editor.dispose();
			return;
		}
		if (editError !== null) opened(editError);
		else attach(editor);
	}

	/** Open the editor once; later calls join the work already pending. */
	function open(): Promise<void> {
		if (gated || mode.kind === 'editing') return idle();
		if (mode.kind === 'opening') return idle();
		return track(acquire);
	}

	/**
	 * One save of the whole word, then a read of the file. Answers why it
	 * did not land, or null.
	 */
	function save(editor: WordEditor): Promise<string | null> {
		return track(async () => {
			try {
				const { data: receipt, error } = await editor.save();
				if (error !== null) return error.message;
				thrown = undefined;
				const entry = entryOf(receipt);
				if (entry !== undefined) onSaved(entry);
				return null;
			} catch (cause) {
				// Storage that throws is not an answer. The note stays unsaved.
				thrown = extractErrorMessage(cause);
				return thrown;
			} finally {
				await editor.refresh();
			}
		});
	}

	/** Why there is no editor to save with, when there is none. */
	function unavailable(): string | null {
		if (gated) return stopped();
		switch (mode.kind) {
			case 'repair':
				return `This word's file needs repair before it can be edited: ${mode.reason}`;
			case 'unavailable':
				return mode.message;
			default:
				return null;
		}
	}

	/** Why a stage does not save now: the latest read waits for a review. */
	function held(): string | null {
		if (deletion !== undefined)
			return 'Deleting this word was not confirmed. Choose whether to keep it first.';
		switch (review?.kind) {
			case 'changed':
				return 'This word changed in another tab while you were typing. Choose which note to keep first.';
			case 'invalid':
				return 'This word was changed in another tab into text Vocab cannot read as a word. Choose what to keep first.';
			case 'unreadable':
				return 'This word cannot be read just now. Your note is kept here.';
			default:
				return null;
		}
	}

	/** Take the latest valid read in place of the local word, answering any outcome. */
	function takeSaved(): string | null {
		if (gated) return stopped();
		if (mode.kind !== 'editing' || state === undefined) return null;
		if (working > 0) return 'This word is being saved. Try again in a moment.';
		const { observation, lastSave } = state;
		if (observation.kind !== 'present')
			return 'This word could not be read just now, so there is no saved word to go back to.';
		const { error: adoptError } = mode.editor.adopt(observation.revision);
		if (adoptError !== null) return adoptError.message;
		acknowledged = lastSave;
		thrown = undefined;
		deletion = undefined;
		pendingNote = undefined;
		return null;
	}

	function dispose(): Promise<void> {
		disposal ??= (async () => {
			gated = true;
			retired = true;
			await idle();
			if (mode.kind === 'editing') await mode.editor.dispose().catch(noop);
		})();
		return disposal;
	}

	return {
		id,
		get mode() {
			return mode;
		},
		/** The editor's state while it owns the text: document, baseline, latest read, last save. */
		get state() {
			return state;
		},
		/** A save that did not land or whose answer was lost, until the learner answers it. */
		get outcome() {
			return outcome;
		},
		/** What the latest read of the file asks the learner to review first. */
		get review() {
			return review;
		},
		/** A note typed while no editor can hold it, such as while the file needs repair. */
		get pendingNote() {
			return pendingNote;
		},
		/** Drop a note that no editor could hold. */
		discardNote() {
			if (!gated) pendingNote = undefined;
		},
		get saving() {
			return working > 0 || state?.saving !== undefined;
		},
		/** Deletion or disposal is under way. */
		get gated() {
			return gated;
		},
		/** Whether anything typed here is not saved. */
		get unsettled() {
			return (
				dirty() ||
				pendingNote !== undefined ||
				repairTyped() ||
				// An unanswered delete keeps even a clean word: letting it go is a choice.
				deletion !== undefined ||
				working > 0 ||
				state?.saving !== undefined
			);
		},
		open,
		/** Read the word again, if its editor is open. */
		refresh: () =>
			mode.kind === 'editing' && !gated
				? mode.editor.refresh()
				: Promise.resolve(),
		/** Settles once no tracked operation is pending. */
		idle,

		/** The note the field shows: what is typed here, else `listed`. */
		note(listed: string): string {
			if (pendingNote !== undefined) return pendingNote;
			const local = state?.document.fields.note;
			if (mode.kind !== 'editing' || local === undefined) return listed;
			// A value that is not text is shown as written, never hidden.
			return typeof local === 'string' ? local : JSON.stringify(local);
		},
		/** The stage the controls show: this word's local one, else `listed`. */
		stage(listed: Stage): unknown {
			if (mode.kind !== 'editing' || state === undefined) return listed;
			return state.document.fields.stage;
		},
		/** Problems with the word as it is held here, which a save would refuse. */
		get issues(): string[] {
			if (mode.kind !== 'editing' || state === undefined) return [];
			const { reading } = state;
			if (reading.parseError !== undefined) return [reading.parseError.message];
			return reading.issues.map((issue) => issue.message);
		},

		/**
		 * Type the note. It is kept here even while nothing may save it. While
		 * the word is being deleted or closed, nothing typed is taken.
		 */
		inputNote(text: string) {
			if (gated) return;
			if (mode.kind === 'editing') {
				const { error: changeError } = mode.editor.change({
					fields: { note: text },
				});
				if (changeError === null) {
					pendingNote = undefined;
					return;
				}
			}
			pendingNote = text;
			if (mode.kind === 'closed') void open();
		},
		/**
		 * Leaving the field saves the word when it has unsaved text and nothing
		 * waits for the learner. Leaving it while the editor opens saves once it
		 * has. Answers why nothing was saved, or null.
		 */
		async blur(): Promise<string | null> {
			if (gated) return stopped();
			// With nothing pending, this save starts now, with the note as it is.
			if (tail) await idle();
			if (gated) return stopped();
			if (mode.kind !== 'editing')
				return pendingNote === undefined ? null : unavailable();
			if (!dirty() || outcome !== undefined || review !== undefined)
				return null;
			return save(mode.editor);
		},
		/**
		 * Press a stage: set it and save the whole word, with the note as typed.
		 * Refused while something about the file waits for the learner's choice.
		 */
		async setStage(stage: Stage): Promise<string | null> {
			if (gated) return stopped();
			await open();
			await idle();
			if (gated) return stopped();
			if (mode.kind !== 'editing') return unavailable();
			const waiting = held();
			if (waiting !== null) return waiting;
			const { error: changeError } = mode.editor.change({ fields: { stage } });
			if (changeError !== null) return changeError.message;
			thrown = undefined;
			return save(mode.editor);
		},
		/**
		 * The learner's explicit save: keep my word over what was shown from
		 * another tab, or try again after a failure or an unknown outcome. It
		 * sends the whole word again, even when it reads as saved. A file that
		 * cannot be read cannot be reviewed, so nothing is saved over it,
		 * whatever an earlier save's outcome was.
		 */
		async saveMine(): Promise<string | null> {
			if (gated) return stopped();
			await idle();
			if (gated) return stopped();
			if (mode.kind !== 'editing') return unavailable();
			if (review?.kind === 'unreadable')
				return 'This word cannot be read just now, so it cannot be reviewed. Try again later.';
			thrown = undefined;
			// Saving it is the learner's answer to a delete whose answer was lost.
			deletion = undefined;
			return save(mode.editor);
		},
		/** Take the word as last read in place of the note typed here. */
		keepSaved: takeSaved,
		/**
		 * Repair the file's text, exactly as the latest read found it, dropping
		 * the note typed here. For a file changed elsewhere into one that is not
		 * a valid word.
		 */
		async repairFile(): Promise<void> {
			if (gated || review?.kind !== 'invalid' || working > 0) return;
			if (mode.kind !== 'editing') return;
			const { editor } = mode;
			const { file, message } = review;
			state = undefined;
			pendingNote = undefined;
			mode = {
				kind: 'repair',
				file: captureOf(file),
				text: file.source,
				reason: message,
				problem: undefined,
			};
			await track(() => editor.dispose());
		},

		/** The exact text of a word that needs repair, as typed here. */
		get repairText() {
			return mode.kind === 'repair' ? mode.text : undefined;
		},
		get repairProblem() {
			return mode.kind === 'repair' ? mode.problem : undefined;
		},
		inputRepair(text: string) {
			if (!gated && mode.kind === 'repair')
				mode = { ...mode, text, problem: undefined };
		},
		/**
		 * Write the repair text exactly, only over the version that was shown,
		 * then open the word again. A file changed meanwhile is shown, and the
		 * text stays. Text typed while the repair was out stays, over what was
		 * written, for another explicit repair.
		 */
		writeRepair(): Promise<void> {
			if (gated || mode.kind !== 'repair') return Promise.resolve();
			return track(async () => {
				if (mode.kind !== 'repair') return;
				const { file, text } = mode;
				try {
					const { data: replaced, error: replaceError } = await table.replace(
						file,
						text,
					);
					if (replaceError === null) {
						const entry = readEntry(replaced);
						if (entry !== undefined) onSaved(entry);
						if (mode.kind !== 'repair') return;
						mode = { ...mode, file: captureOf(replaced), problem: undefined };
						if (mode.text === text && !retired) await acquire();
						return;
					}
					if (replaceError.name !== 'Conflict') {
						if (mode.kind === 'repair')
							mode = { ...mode, problem: replaceError.message };
						return;
					}
					const { data: current, error: readError } = await table.get(id);
					if (mode.kind !== 'repair') return;
					if (readError !== null || current === undefined) {
						mode = {
							...mode,
							problem:
								readError?.message ??
								'This word was removed in another tab, so your text was not saved.',
						};
						return;
					}
					mode = {
						...mode,
						file: captureOf(current),
						problem:
							'The file changed in another tab, so your text was not saved. Saving again replaces the version shown now.',
					};
				} catch (cause) {
					if (mode.kind === 'repair')
						mode = { ...mode, problem: extractErrorMessage(cause) };
				}
			});
		},

		/**
		 * Delete the word with `remove`, after every operation already admitted.
		 * No view of the word starts new work or takes typing meanwhile. Refused,
		 * the word goes on with everything typed in it; done, it is disposed.
		 * With no answer, thrown or `Unconfirmed`, the word may or may not be
		 * gone: it is kept, usable, and nothing writes it until the learner saves
		 * it back, takes the saved word, or lets it go.
		 */
		async remove<
			T extends {
				readonly error: {
					readonly name: string;
					readonly message: string;
				} | null;
			},
		>(remove: () => Promise<T>): Promise<T> {
			gated = true;
			let removed: T;
			try {
				removed = await track(remove);
			} catch (cause) {
				if (!retired) gated = false;
				deletion = extractErrorMessage(cause);
				throw cause;
			}
			const { error: removeError } = removed;
			if (removeError === null) {
				await dispose();
				return removed;
			}
			if (!retired) gated = false;
			if (removeError.name === 'Unconfirmed') deletion = removeError.message;
			return removed;
		},

		/**
		 * Close the gate and let go of the editor once every operation already
		 * admitted has settled. Nothing starts afterwards. Repeated calls share
		 * one disposal.
		 */
		dispose,
	};
}
