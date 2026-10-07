/**
 * One open note: the app's policy around the folder's row editor
 * (`folder.tables.notes.edit`).
 *
 * The row editor owns the note's one input: the complete text it was last
 * given or deliberately read, and one queue that publishes that text over the
 * existing file, one write at a time with only the latest waiting. Accepted
 * input goes to it at once, a structured replacement as the complete
 * document through `set` and the file view's exact text through `setText`;
 * there is no second draft here. A failed or unconfirmed write keeps the
 * input and error visible; newer input saves again. Try again (`retry`)
 * saves the current input without changing it. Every write replaces the file as it is; none creates it. The
 * editor never reads the file by itself: another program's change shows only
 * when the person reloads (`reload`), and a reload that fails changes nothing.
 * The views read the editor's row through this owner and never copy it.
 *
 * This app-owned editor keeps the native publisher internal and owns these rules:
 *
 * - Whether a valid note shows its fields or its file (`rawMode`).
 * - Admission. Input is refused while a close is answered (`admits`), while a
 *   rename, delete, or reload of this note runs, while a rename or delete of it
 *   stopped short or the person stopped tracking one, and for good once
 *   released. Refused input changes nothing in the editor.
 * - Typed text the editor refused. A title or Markdown source the file cannot
 *   hold exactly (an unpaired surrogate) stays in that control with the
 *   reason, because the control would otherwise snap back to the editor's
 *   value. It is never submitted, and it is not a draft of the note.
 * - The rename or delete being tracked, and one the person stopped tracking.
 *
 * Views keep their own mount guard: a control something still holds can
 * deliver input after its view is gone.
 */
import type {
	CanonicalDocument,
	RowEditor,
	RowError,
	RowSaveError,
} from '@epicenter/folder';
import { fromRowEditor } from '@epicenter/folder/svelte';
import type { NoteFields } from './data.js';
import type {
	DetachedChange,
	PathChange,
	PathStep,
	SessionStatus,
} from './file-session.svelte.js';

const UNENCODABLE =
	'The text has a character UTF-8 cannot hold (an unpaired surrogate), so it is not written.';

type ReloadError = NonNullable<
	Awaited<ReturnType<RowEditor<NoteFields>['reload']>>['error']
>;

/** A text control whose typed value the editor can refuse. */
export type TypedField = 'title' | 'body';
/**
 * The control a complete document was composed in. A title or Source control
 * keeps a value the editor refuses; the rich-text view shows only what the
 * editor acknowledged.
 */
export type NoteControl = TypedField | 'rich';
/** What the person typed in one control and the editor refused, and why. */
export type RefusedInput = { readonly value: string; readonly reason: string };

/** A rename or delete the person stopped tracking; nothing saves by itself until they choose. */
export type NoteHold = {
	readonly kind: 'detached';
	readonly message: string;
	readonly change: DetachedChange;
};

export type NoteEditor = ReturnType<typeof createNoteEditor>;

/** Why readable text has no structured form, in the library's words. */
export function problemsOf(error: RowError): string[] {
	switch (error.name) {
		case 'NoCanonicalForm':
			return [error.refusal.reason];
		case 'Nonconforming':
			return error.reading.issues.map((issue) => issue.message);
		case 'Unencodable':
			return [UNENCODABLE];
		default:
			return error satisfies never;
	}
}

/**
 * What a person is told about a write that did not end saved. An
 * unconfirmed one may have landed: it is uncertainty, never a failure, and
 * its message keeps the folder's details, such as where displaced bytes
 * were kept.
 */
export function noteSaveProblem(error: RowSaveError): string {
	switch (error.name) {
		case 'Unconfirmed':
			return `The save was not confirmed, so the file may or may not have it: ${error.message}`;
		case 'NotFound':
			return 'Not saved: the file was not there when this was saved, and saving does not create it again.';
		case 'Unencodable':
			return `Not saved: ${UNENCODABLE}`;
		default:
			return `Not saved: ${error.message}`;
	}
}

/** What a person is told about a reload that loaded nothing. Their text is unchanged either way. */
export function reloadProblem(error: ReloadError): string {
	switch (error.name) {
		case 'InputChanged':
			return 'The text changed while the file was being read, so the file was not loaded.';
		case 'NotFound':
			return 'The file is not in the folder, so nothing was loaded.';
		case 'InvalidUtf8':
			return 'The file is not UTF-8 text, so nothing was loaded.';
		default:
			return `The file could not be read, so nothing was loaded: ${error.message}`;
	}
}

const FIELD_NAMES: Record<TypedField, string> = {
	title: 'the title',
	body: 'the Markdown source',
};

export function createNoteEditor(
	native: RowEditor<NoteFields>,
	{
		path,
		admits = () => true,
		rawMode = false,
	}: {
		/** The row's path. The editor is fixed to it. */
		path: string;
		/** Whether the person's input is being taken. False while a close is answered. */
		admits?: () => boolean;
		/** Whether the note starts in its file view. */
		rawMode?: boolean;
	},
) {
	const editor = fromRowEditor(native);
	/** Whether a valid note shows its file view. An invalid one always does. */
	let raw = $state(rawMode);
	let pathChange = $state.raw<PathChange | undefined>();
	let hold = $state.raw<NoteHold | undefined>();
	/** Why the last input or choice was refused; the next accepted one clears it. */
	let refusal = $state<string | undefined>();
	let refused = $state.raw<Partial<Record<TypedField, RefusedInput>>>({});
	/** Why the person's last reload loaded nothing, until a reload loads or input is taken. */
	let reloadError = $state.raw<ReloadError | undefined>();
	/** Path changes and departures running: they take no input. */
	let operating = $state(0);
	let reloading = $state(false);
	let released = $state(false);

	/** Why no input or choice is taken now, or undefined. */
	function fenced(): string | undefined {
		if (released) return 'This note was closed here.';
		if (!admits()) return 'The app is closing, so nothing was changed.';
		if (operating > 0)
			return 'A rename or delete of this note is running. Try again when it finishes.';
		if (reloading)
			return 'The file is being read again. Try again when it finishes.';
		return undefined;
	}

	/**
	 * Why typing is not taken now. A text change publishes, so nothing
	 * is taken while a rename or delete stopped short or stopped being
	 * tracked: it would write at a path whose file is not known.
	 */
	function blocked(): string | undefined {
		const why = fenced();
		if (why !== undefined) return why;
		if (pathChange !== undefined)
			return 'A rename or delete of this note is not finished, so nothing more is saved here.';
		if (hold !== undefined)
			return 'You stopped tracking a rename or delete of this note. Save it here or reload the file first.';
		return undefined;
	}

	function accepted() {
		refusal = undefined;
		reloadError = undefined;
	}

	/**
	 * Give the structured note a complete document: every field to keep,
	 * unknown keys included, and the body. A key left out is removed. Taken
	 * only while the note reads as valid and shows its fields. Answers why it
	 * was not taken.
	 *
	 * Typed text a control holds blocks a document that changes its field
	 * from what the editor holds; the control it was typed in is the one that
	 * changes it. A `title` or `body` control keeps its own value when the
	 * editor refuses it, and an accepted one clears it. The rich-text view
	 * (`rich`) never writes over Source that holds typed text, and keeps
	 * nothing the editor refuses. For it alone, the current row unchanged is
	 * taken without a save: a paragraph Markdown has no spelling for is shown
	 * and changes nothing. Any other unchanged document is saved again, which
	 * writes the file in its canonical form.
	 */
	function set(
		next: CanonicalDocument,
		{ control }: { control?: NoteControl } = {},
	): string | undefined {
		const why = blocked();
		if (why !== undefined) return why;
		const { row } = native.get();
		if (row.status !== 'valid' || raw)
			return 'This note is not showing its fields.';
		const changes: Record<TypedField, boolean> = {
			title: next.fields.title !== row.fields.title,
			body: next.body !== row.body,
		};
		const held = (Object.keys(refused) as TypedField[]).find(
			(field) =>
				(field === 'body' && control === 'rich') ||
				(field !== control && changes[field]),
		);
		if (held !== undefined) {
			refusal = `What you typed in ${FIELD_NAMES[held]} is not saved. Change it there first.`;
			return refusal;
		}
		if (control === 'rich' && next === row) return undefined;
		const { error } = native.set(next);
		if (control === 'title' || control === 'body') {
			const { [control]: _settled, ...others } = refused;
			const value = control === 'title' ? next.fields.title : next.body;
			refused =
				error === null || typeof value !== 'string'
					? others
					: { ...others, [control]: { value, reason: error.message } };
		}
		if (error !== null) {
			refusal = error.message;
			return refusal;
		}
		accepted();
		return undefined;
	}

	// Views derive from these, so they read the editor's save state tracked.
	const missing = () => {
		const { save } = editor;
		return (
			(save.status === 'failed' && save.error.name === 'NotFound') ||
			reloadError?.name === 'NotFound'
		);
	};

	const unsettled = () =>
		editor.save.status !== 'idle' ||
		pathChange !== undefined ||
		hold !== undefined ||
		Object.keys(refused).length > 0;

	return {
		path,
		/** The row editor's current snapshot, read without tracking. */
		get: native.get,
		/** The editor's input: valid or invalid. */
		get row() {
			return editor.row;
		},
		/** The editor's publication: idle, saving, or failed. */
		get save() {
			return editor.save;
		},
		/** Typed values the editor refused, by the control they were typed in. */
		get refused() {
			return refused;
		},
		/** Why the person's last reload loaded nothing. */
		get reloadError() {
			return reloadError;
		},
		/**
		 * The file was not there at the last save or reload. Saving the text as
		 * a file again is a separate, exclusive create.
		 */
		get missing() {
			return missing();
		},
		get rawMode() {
			return raw;
		},
		get pathChange() {
			return pathChange;
		},
		get hold() {
			return hold;
		},
		/** Why the last input or choice was not taken. */
		get refusal() {
			return refusal;
		},
		get released() {
			return released;
		},
		/** Whether typing is being taken. */
		get admitting() {
			return blocked() === undefined;
		},
		/** Whether the person's choices (reload, stop tracking, save here) are being taken. */
		get canChoose() {
			return fenced() === undefined;
		},
		/**
		 * A rename, delete, or departure of this note is running. A running
		 * write is not: newer input queues behind it.
		 */
		get busy() {
			return operating > 0 || pathChange?.state === 'sent';
		},
		get status(): SessionStatus {
			if (pathChange !== undefined)
				return pathChange.state === 'sent' ? 'saving' : 'unconfirmed';
			const { save } = editor;
			if (save.status === 'saving') return 'saving';
			if (save.status === 'failed')
				return save.error.name === 'Unconfirmed' ? 'unconfirmed' : 'failed';
			if (hold !== undefined) return 'failed';
			return Object.keys(refused).length > 0 ? 'dirty' : 'saved';
		},
		/** Whether leaving now could lose text, leave an outcome unknown, or skip a choice. */
		get unsettled() {
			return unsettled();
		},
		set,
		/**
		 * Replace the whole text, as the file view does. Taken only while the
		 * file view is showing. Typing here keeps the file view after the text
		 * reads as a note again.
		 */
		setText(text: string): string | undefined {
			const why = blocked();
			if (why !== undefined) return why;
			if (native.get().row.status === 'valid' && !raw)
				return 'This note is not showing its file.';
			raw = true;
			native.setText(text);
			accepted();
			return undefined;
		},
		/** Record that a view refused a change; the editor is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		/**
		 * Show the whole file (`true`) or the note's fields (`false`). Nothing
		 * is saved or discarded. The fields show only for text that reads as a
		 * note, and the file only once no typed value is waiting in a field.
		 */
		showFile(on: boolean): string | undefined {
			const why = fenced();
			if (why !== undefined) return why;
			const { row } = native.get();
			if (on) {
				const waiting = (Object.keys(refused) as TypedField[])[0];
				if (waiting !== undefined)
					return `What you typed in ${FIELD_NAMES[waiting]} is not saved: ${refused[waiting]?.reason}`;
			} else if (row.status !== 'valid')
				return `This file cannot be opened as a note yet: ${problemsOf(row.error)[0]}`;
			raw = on;
			return undefined;
		},
		/**
		 * The person's Try again after a failed or unconfirmed write: the editor
		 * publishes what it holds now without changing the input.
		 */
		retry(): string | undefined {
			const why = blocked();
			if (why !== undefined) return why;
			if (native.get().save.status !== 'failed') return undefined;
			native.retry();
			accepted();
			return undefined;
		},
		/**
		 * Read the file again, as the person chose, and show it in place of
		 * what the editor holds, unsaved text included. Input is refused while
		 * it reads. A read that fails, or that input overtook, changes nothing:
		 * the text and its save state stay. A loaded file ends a stopped-tracking
		 * hold, since the person chose to go on with this path.
		 */
		async reload(): Promise<string | undefined> {
			const why =
				fenced() ??
				(pathChange === undefined
					? undefined
					: 'A rename or delete of this note is not finished. Stop tracking it first.');
			if (why !== undefined) return why;
			reloading = true;
			try {
				const { error } = await native.reload();
				if (released) return undefined;
				if (error !== null) {
					reloadError = error;
					return reloadProblem(error);
				}
				refused = {};
				hold = undefined;
				accepted();
				return undefined;
			} finally {
				reloading = false;
			}
		},
		/**
		 * After the person stopped tracking a rename or delete: go on at this
		 * path and save the text the editor holds here again.
		 */
		saveHere(): string | undefined {
			const why = fenced();
			if (why !== undefined) return why;
			if (hold === undefined) return undefined;
			hold = undefined;
			const { row, save } = native.get();
			if (save.status === 'failed') native.retry();
			else native.setText(row.text);
			accepted();
			return undefined;
		},
		/**
		 * Wait for every write already admitted and report the last outcome.
		 * Waiting never resubmits a failed write.
		 */
		waitForSaves: native.waitForSaves,
		/** Run `work` with input fenced: a rename, a delete, a departure. */
		async operate<T>(work: () => Promise<T>): Promise<T> {
			operating += 1;
			try {
				return await work();
			} finally {
				operating -= 1;
			}
		},
		/** Record a rename or delete of this file that was sent. */
		track(step: PathStep) {
			pathChange = { ...step, state: 'sent' };
		},
		/** The reply to the change being tracked: unknown or partial outcomes are kept. */
		conclude(step: PathStep, answer: { kind: string; message?: string }): void {
			if (answer.kind === 'unconfirmed' || answer.kind === 'sourceNotRemoved')
				pathChange = {
					...step,
					state: answer.kind,
					problem: answer.message ?? '',
				};
			else pathChange = undefined;
		},
		/**
		 * Stop tracking a rename or delete whose outcome is not known, or a move
		 * that kept its source, as the person chose. The text stays, and
		 * nothing is saved or typed here until they save it here or reload.
		 */
		detach(): boolean {
			if (
				fenced() !== undefined ||
				pathChange === undefined ||
				pathChange.state === 'sent'
			)
				return false;
			const change = pathChange;
			hold = {
				kind: 'detached',
				change,
				message:
					change.kind === 'remove'
						? `Deleting "${change.from.path}" was not confirmed`
						: change.state === 'sourceNotRemoved'
							? `Renaming "${change.from.path}" created "${change.to}" and could not remove the original`
							: `Renaming "${change.from.path}" to "${change.to}" was not confirmed`,
			};
			pathChange = undefined;
			return true;
		},
		/**
		 * Stop using the editor, for good: this owner refuses every input and
		 * choice from now on. A write already admitted still settles in the
		 * editor.
		 */
		release() {
			if (released) return;
			released = true;
			refused = {};
		},
	};
}
