/**
 * One open note's structured editing: the app's lifecycle around the
 * folder's row editor (`folder.tables.<name>.edit`).
 *
 * The editor owns the document, the baseline it compares the document with,
 * the admitted save, the latest read, and save history. A save writes the
 * complete canonical document over whatever the file holds. This session
 * owns only what the app decides:
 *
 * - When to save. Typing saves after a pause. A save that failed, threw, or
 *   got no reply holds the session until the person chooses: a new save,
 *   confirmed, or taking the file as it is (`adopt`). The hold counts toward
 *   status, settling, and closing whether or not the draft differs from the
 *   file, and nothing that would hand the note to another owner (a rename,
 *   a delete, editing it as a file) goes ahead past it. The editor's
 *   `lastSave` keeps the outcome as it was; a later read that finds the same
 *   content says what the file holds, never which save put it there.
 *   Autosave also waits while a read found the file changed under unsaved
 *   input, and while a rename or delete runs.
 * - Whether input is taken: not while a close is answered.
 * - A rename or delete of this file. The editor is fixed to its path, so the
 *   owner opens a new editor at the destination of a confirmed move and
 *   carries this document into it.
 *
 * The views share one session: the title, folder, and pin controls, the
 * rich-text view, and the Markdown view all change the same document.
 */
import type {
	FileCapture,
	RowChange,
	RowEditor,
	RowEditorState,
	RowSaveError,
} from '@epicenter/folder';
import type {
	FileOutcome,
	PathChange,
	PathStep,
	SessionStatus,
} from './file-session.svelte.js';

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 500;

/**
 * A move or removal of this row's file. `stranded`: the move was confirmed,
 * and no editor could be opened at the destination.
 */
export type RowPathChange =
	| PathChange
	| (PathStep & { readonly state: 'stranded'; readonly problem: string });

/** A rename or delete of this row's file that stopped short of an answer. */
export type StuckPathChange = Exclude<RowPathChange, { state: 'sent' }>;

/** Why autosave waits for the person; see `hold` in `createRowSession`. */
export type RowHold =
	| {
			readonly kind: 'failed' | 'unconfirmed';
			/** What happened, in the library's words. */
			readonly message: string;
	  }
	| {
			readonly kind: 'detached';
			readonly message: string;
			/** The rename or delete as it stood when the person stopped tracking it. */
			readonly change: StuckPathChange;
	  };

export type RowSession<TFields> = ReturnType<typeof createRowSession<TFields>>;

export function createRowSession<TFields>(
	editor: RowEditor<TFields>,
	{
		admits = () => true,
		onSaved = () => {},
	}: {
		/** Whether the person's input is being taken. False while a close is answered. */
		admits?: () => boolean;
		/** After a save was confirmed. */
		onSaved?: () => void;
	} = {},
) {
	let state = $state.raw<RowEditorState<TFields>>(editor.get());
	const stopListening = editor.subscribe((next) => {
		state = next;
	});
	let pathChange = $state.raw<RowPathChange | undefined>();
	/** Why the last change was refused; the next accepted change clears it. */
	let refusal = $state<string | undefined>();
	/** Why the last save asked for wrote nothing before it reached the file. */
	let notice = $state<string | undefined>();
	/**
	 * What the person has to choose about before anything is saved by itself:
	 *
	 * - `failed`: a save failed.
	 * - `unconfirmed`: a save got no reply, or storage threw during the save
	 *   or the read after it, so whether it landed is unknown.
	 * - `detached`: the person stopped tracking a rename or delete whose
	 *   outcome is not known, so this editor's file is not known to be the
	 *   note's any more.
	 *
	 * Only a save the person asks for, confirmed, or taking the file as it is
	 * (`adopt`) ends it. A read that finds the draft's content in the file
	 * answers none of these: it says what the file holds, not what happened.
	 * The hold counts whether or not anything is unsaved.
	 */
	let hold = $state.raw<RowHold | undefined>();
	/**
	 * From a save's admission until the read after it. The latest read may
	 * predate the save's receipt then, so it is not a change on disk.
	 */
	let settling = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let tail: Promise<unknown> = Promise.resolve();
	/** Saves, moves, and removals admitted to `exclusive` and not yet settled. */
	let queued = $state(0);

	/**
	 * What the latest read found that the editor has not followed: changed
	 * content under unsaved input, no file, or a file the editor cannot hold.
	 * A clean editor follows a valid read by itself.
	 */
	const external = $derived.by(() => {
		if (settling || state.saving !== undefined) return undefined;
		const { observation, baseline } = state;
		if (
			observation.kind === 'present' &&
			observation.revision.sha256 === baseline.sha256
		)
			return undefined;
		return observation;
	});

	const valid = () =>
		state.reading.parseError === undefined && state.reading.issues.length === 0;
	const autosaves = () =>
		hold === undefined &&
		pathChange === undefined &&
		external === undefined &&
		!state.isDisposed;
	/**
	 * Whether leaving now could lose something, leave an outcome unknown, or
	 * skip a choice the person still has to make.
	 */
	const unsettled = () =>
		state.isDirty ||
		state.saving !== undefined ||
		pathChange !== undefined ||
		hold !== undefined;

	function schedule() {
		clearTimeout(timer);
		if (!autosaves()) return;
		timer = setTimeout(() => void flush(), TYPING_BATCH_MS);
	}

	/**
	 * One save, move, or removal at a time, in the order asked. It counts as
	 * queued from the call, before its turn comes.
	 */
	function exclusive<T>(work: () => Promise<T>): Promise<T> {
		queued += 1;
		const result = tail.then(work).finally(() => {
			queued -= 1;
		});
		tail = result.catch(() => {});
		return result;
	}

	/** Submit the document, then read once more so the latest read follows the save. */
	async function submit(): Promise<RowSaveError | undefined> {
		clearTimeout(timer);
		settling = true;
		let error: RowSaveError | null;
		try {
			({ error } = await editor.save());
			await editor.refresh();
		} catch (cause) {
			// Storage that throws is a bug in it. The save may have landed before
			// the save or the read after it threw: the outcome is unknown.
			hold = {
				kind: 'unconfirmed',
				message: cause instanceof Error ? cause.message : String(cause),
			};
			return undefined;
		} finally {
			settling = false;
		}
		if (error === null) {
			hold = undefined;
			notice = undefined;
			onSaved();
			// Typing during the save stays a draft and saves next.
			if (state.isDirty) schedule();
			return undefined;
		}
		switch (error.name) {
			case 'InvalidDocument':
				// The field that needs fixing, not the library's words for the document.
				notice =
					error.reading.parseError?.message ??
					error.reading.issues[0]?.message ??
					error.message;
				break;
			case 'Saving':
			case 'Disposed':
				break;
			default:
				// The editor keeps the failed or unconfirmed attempt in `lastSave`;
				// this is the app's hold on it, until the person chooses.
				hold = {
					kind: error.name === 'Unconfirmed' ? 'unconfirmed' : 'failed',
					message: error.message,
				};
		}
		return error;
	}

	/** Save unsaved, valid input while autosave is on. Waits for work already admitted. */
	function flush(): Promise<void> {
		clearTimeout(timer);
		return exclusive(async () => {
			if (autosaves() && state.isDirty && valid()) await submit();
		});
	}

	return {
		/** The editor's state: document, baseline, latest read, save history. */
		get state() {
			return state;
		},
		get path() {
			return state.path;
		},
		get dirty() {
			return state.isDirty;
		},
		get external() {
			return external;
		},
		get pathChange() {
			return pathChange;
		},
		get refusal() {
			return refusal;
		},
		get notice() {
			return notice;
		},
		/** What the person has to choose about before anything is saved by itself. */
		get hold() {
			return hold;
		},
		/**
		 * Whether a save, rename, or delete is queued, admitted, or awaiting the
		 * read after it. What it comes to is not known yet, so a command that
		 * would save after it is not taken.
		 */
		get busy() {
			return (
				queued > 0 ||
				settling ||
				state.saving !== undefined ||
				pathChange !== undefined
			);
		},
		/** Whether autosave waits for the person's choice. */
		get paused() {
			return hold !== undefined;
		},
		get status(): SessionStatus {
			if (pathChange !== undefined)
				return pathChange.state === 'sent' ? 'saving' : 'unconfirmed';
			if (state.saving !== undefined || settling) return 'saving';
			if (hold?.kind === 'unconfirmed') return 'unconfirmed';
			if (external !== undefined) return 'conflict';
			// A hold stands whether or not the draft differs from the file.
			if (hold !== undefined) return 'failed';
			return state.isDirty ? 'dirty' : 'saved';
		},
		get unsettled() {
			return unsettled();
		},
		/** Whether the person's input and choices are being taken. */
		get admitting() {
			return admits();
		},
		/**
		 * Change the document. Returns false, and changes nothing, while input
		 * is fenced or when the editor refuses the value.
		 */
		change(change: RowChange<TFields>): boolean {
			if (!admits()) return false;
			const { error: changedError } = editor.change(change);
			if (changedError !== null) {
				refusal = changedError.message;
				return false;
			}
			refusal = undefined;
			schedule();
			return true;
		},
		/** Record that a view refused a change; the document is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		/**
		 * Save the document now, as the person asked. This is a new attempt,
		 * whatever an earlier one came to; a confirmed one starts autosave
		 * again. Resolves why it did not end saved, or undefined.
		 */
		saveNow(): Promise<string | undefined> {
			if (!admits())
				return Promise.resolve('The app is closing, so nothing was saved.');
			clearTimeout(timer);
			return exclusive(async () => {
				if (pathChange !== undefined)
					return 'A rename or delete of this note is not finished.';
				const error = await submit();
				// Storage that threw leaves an unconfirmed hold and no error: the
				// outcome is unknown, so this does not report it saved.
				if (error === undefined) return hold?.message;
				if (error.name === 'InvalidDocument') return notice;
				return error.message;
			});
		},
		/**
		 * Take the version the person reviewed in place of the draft. This is
		 * their choice about a failed or unconfirmed save too, so autosave
		 * starts again; `lastSave` keeps what that save came to. False when the
		 * reviewed version is not the latest read.
		 */
		adopt(reviewed: { path: string; canonical: string }): boolean {
			if (!admits() || pathChange !== undefined) return false;
			if (editor.adopt(reviewed).error !== null) return false;
			refusal = undefined;
			notice = undefined;
			hold = undefined;
			return true;
		},
		/** Read the file now. */
		refresh: () => editor.refresh(),
		/** Save pending input if autosave may, and say whether nothing is left open. */
		async settle(): Promise<boolean> {
			await flush();
			return !unsettled();
		},
		/**
		 * Settle, then run one move or removal of this file on the capture the
		 * editor agrees with (`from` names one the person confirmed). Input is
		 * still taken while it runs and nothing is saved. An unknown outcome, or a
		 * move that kept its source, is kept. After a confirmed one the owner decides: reopen at
		 * the destination, or forget the session.
		 */
		changePath<T>(
			step: (from: FileCapture) => PathStep,
			run: (from: FileCapture) => Promise<FileOutcome<T>>,
		): Promise<FileOutcome<T> | { readonly kind: 'unsettled' }> {
			if (!admits()) return Promise.resolve({ kind: 'unsettled' });
			clearTimeout(timer);
			return exclusive(async () => {
				if (autosaves() && state.isDirty && valid()) await submit();
				if (unsettled() || external !== undefined)
					return { kind: 'unsettled' } as const;
				const { path, sha256 } = state.baseline;
				const sent = step({ path, sha256 });
				pathChange = { ...sent, state: 'sent' };
				const answer = await run(sent.from);
				if (answer.kind === 'unconfirmed' || answer.kind === 'sourceNotRemoved')
					pathChange = { ...sent, state: answer.kind, problem: answer.message };
				else if (answer.kind !== 'done') {
					// Nothing changed: this editor goes on as it was.
					pathChange = undefined;
					void editor.refresh();
					if (state.isDirty) schedule();
				} else if (sent.kind === 'remove') {
					// The file is gone. The read that says so lands before the
					// removal ends, so typing that arrived meanwhile stays a draft
					// and nothing saves it back by itself.
					await editor.refresh();
					pathChange = undefined;
				}
				// A confirmed move stays `sent` until the owner reopens or strands it.
				return answer;
			});
		},
		/**
		 * Stop tracking a rename or delete whose outcome is not known, or a move
		 * that kept its source or could not be reopened, as the person chose.
		 * Nothing is concluded about where the file is: the draft stays, and
		 * nothing is saved by itself until the person saves it, takes the file
		 * at this path as it is, or discards the draft. Its paths can be opened
		 * and inspected again. False when nothing is stuck.
		 */
		detach(): boolean {
			if (!admits() || pathChange === undefined || pathChange.state === 'sent')
				return false;
			const change = pathChange;
			hold = {
				kind: 'detached',
				change,
				message:
					change.kind === 'remove'
						? `Deleting "${change.from.path}" was not confirmed`
						: change.state === 'stranded'
							? `"${change.from.path}" was moved to "${change.to}", and could not be opened there`
							: change.state === 'sourceNotRemoved'
								? `Renaming "${change.from.path}" created "${change.to}" and could not remove the original`
								: `Renaming "${change.from.path}" to "${change.to}" was not confirmed`,
			};
			pathChange = undefined;
			void editor.refresh();
			return true;
		},
		/** A confirmed move whose destination could not be opened: save nothing more here. */
		strand(problem: string) {
			if (pathChange?.state === 'sent' && pathChange.kind === 'move')
				pathChange = { ...pathChange, state: 'stranded', problem };
		},
		/**
		 * Make this document the one `from` holds: every field it has, and its
		 * body. For a rename: a new editor at the destination takes what was
		 * typed in the old one, including during the move.
		 */
		carry(from: RowEditorState<TFields>['document']): boolean {
			const fields: Record<string, unknown> = {};
			for (const key of Object.keys(state.document.fields))
				fields[key] = undefined;
			Object.assign(fields, from.fields);
			const { error: changedError } = editor.change({
				fields: fields as RowChange<TFields>['fields'],
				body: from.body,
			});
			if (changedError !== null) return false;
			schedule();
			return true;
		},
		/**
		 * Stop watching. Resolves after a save already admitted settles. A
		 * storage throw already reached the save that met it, so it is not
		 * thrown again here.
		 */
		dispose(): Promise<void> {
			clearTimeout(timer);
			stopListening();
			return editor.dispose().catch(() => {});
		},
	};
}
