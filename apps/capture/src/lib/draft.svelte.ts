/**
 * One open capture: the folder's row editor for its file, and the form text
 * this window holds that is not part of the capture yet.
 *
 * The row editor (`table.edit`) owns the capture's input: the complete text
 * it last accepted and the one queue that publishes it. This module acquires
 * it once and keeps it, above every view, until the capture is let go. Its
 * Svelte facade (`fromRowEditor`) is read through on every access; nothing
 * here copies its row or its save state.
 *
 * Every change is submitted at once as a complete replacement. A structured
 * change (the Capture view) is `set`: the fields the row has, keys Capture
 * does not declare included, and the edited body. A Source edit is
 * `setText`, exactly as typed, frontmatter and malformed text included. The
 * editor writes the latest input over the existing file; a file changed
 * elsewhere is overwritten by the next save, and is shown only when the
 * person reloads.
 *
 * A failed or unconfirmed save pauses publication. Input stays visible and
 * accepted, and nothing is written until the person retries. Reloading reads
 * the file and replaces the input with it.
 *
 * This module holds only what the editor cannot: the new-thought text, a
 * thought being edited, and capture text that could not be applied. Only
 * Add, Save, or a clear lets them go.
 *
 * Deleting, restoring, and copying hold this capture: input stops at once,
 * before anything is awaited, and their file work is the capture's one
 * admitted operation, which leaving and closing wait for.
 */

import {
	addThought,
	type CaptureDocument,
	type CaptureFields,
	deleteThought,
	type Edit,
	editThought,
	fromTextarea,
	parseCapture,
	setText,
	swapThoughts,
	type Thought,
	unparsedCapture,
} from '@epicenter/capture';
import {
	frameRowText,
	type RowEditor,
	type RowError,
	type TableEditError,
	type TableReading,
	type TableSnapshot,
} from '@epicenter/folder';
import {
	fromRowEditor,
	type ReactiveRowEditor,
} from '@epicenter/folder/svelte';
import type { Result } from 'wellcrafted/result';

export type CaptureEntry = TableSnapshot<CaptureFields>;
type CaptureEditor = ReactiveRowEditor<CaptureFields>;

/** What is at the draft's path now. */
export type Current =
	| { readonly kind: 'present'; readonly entry: CaptureEntry }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

type Failure = { readonly name: string; readonly message: string };
type Written =
	| { readonly data: CaptureEntry; readonly error: null }
	| { readonly data: null; readonly error: Failure };

/**
 * Where a draft opens its editor and does its file work. Every method is
 * bound to the draft's own file. Any method may throw; the draft keeps its
 * input.
 */
export type DraftStore = {
	/** How the captures table reads text. It reads nothing. */
	inspect(text: string): TableReading<CaptureFields>;
	/** Acquire the row editor on the file. */
	edit(
		signal: AbortSignal,
	): Promise<Result<RowEditor<CaptureFields>, TableEditError>>;
	/** The file now: a fresh capture of its bytes. */
	read(): Promise<Current>;
	/**
	 * Write exact source where no file is. Refused when anything is there, and
	 * for text a file cannot hold exactly.
	 */
	create(source: string): Promise<Written>;
	/** Delete exactly the reviewed file. Refused if it changed since. */
	remove(reviewed: CaptureEntry): Promise<{ readonly error: Failure | null }>;
	/** Whether the whole collection is fenced: leaving, or closing. */
	fenced(): boolean;
};

/** Why saving waits for the person: work on the file whose result they have not answered. */
export type Notice =
	/** The last save's answer was lost: it may or may not have landed. */
	| { readonly kind: 'unconfirmed'; readonly message: string }
	| {
			readonly kind: 'failed';
			readonly message: string;
			/** The file was gone when the save reached it. Saving never creates it. */
			readonly missing: boolean;
	  }
	/**
	 * A delete was sent and no answer came back: the file may be gone. A
	 * later read showing it present or gone confirms nothing about the delete.
	 */
	| { readonly kind: 'deletion'; readonly message: string }
	/** A reload found no file. Saving never writes it back. */
	| { readonly kind: 'removed' };

/** One edit of a thought, from Edit until it is saved or cancelled. */
export type ThoughtEdit = {
	/** The thought as shown, bound to the parse it came from. */
	readonly thought: Thought;
	readonly text: string;
	/** This edit's identity: a later edit, of the same thought or another, has its own. */
	readonly id: object;
};

/** The file as the person reviews it before deleting it. */
export type DeletionReview = {
	readonly entry: CaptureEntry;
	/** Why it is shown again: it changed since the last review. */
	readonly problem: string | undefined;
};

export type DraftView = 'capture' | 'source';

/** Why exact recovery text is not written: encoding would change it. */
export const UNENCODABLE =
	'This text has a character a file cannot hold exactly, so nothing was written. It is kept here; change that character, or copy the text out.';

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const noop = () => {};

/** Why readable text has no structured form. */
export function describeRowError(error: RowError): string {
	switch (error.name) {
		case 'Nonconforming':
			return error.reading.issues.map((issue) => issue.message).join('; ');
		case 'NoCanonicalForm':
			return error.refusal.reason;
		case 'Unencodable':
			return 'The text has a lone surrogate, which a file cannot hold exactly. It is kept here and not written.';
		default:
			return error satisfies never;
	}
}

/**
 * What holds this capture. While one does, nothing a person does is taken,
 * and nothing is submitted but the operation's own steps.
 */
type Operation = 'opening' | 'deleting' | 'restoring' | 'copying';

/** One parse per text: thoughts belong to the parse that produced them. */
function memo<T>(compute: (text: string) => T) {
	let last: { readonly text: string; readonly value: T } | undefined;
	return (text: string): T => {
		if (last?.text !== text) last = { text, value: compute(text) };
		return last.value;
	};
}

export type Draft = ReturnType<typeof createDraft>;

export function createDraft(
	store: DraftStore,
	{ path, stem }: { readonly path: string; readonly stem: string },
) {
	/** The row editor, kept from acquisition until the capture is let go. */
	let editor = $state.raw<CaptureEditor | undefined>();
	/** Why acquisition gave no editor; `undefined` while one is open or opening. */
	let refused = $state.raw<
		{ readonly missing: boolean; readonly message: string } | undefined
	>();
	/** Acquisition settled. */
	let opened = $state(false);
	let operation = $state<Operation | undefined>();
	/** File work admitted under a hold, until it settles; leaving and closing wait for all of it. */
	const work = new Set<Promise<void>>();
	let opening: AbortController | undefined;

	let newThought = $state('');
	/** The thought being edited, bound to the parse it was shown from. */
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Capture text typed but refused, kept until it applies or is dropped. */
	let pendingText = $state<string | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();
	/** A reload found no file, and nothing was submitted since. */
	let absent = $state(false);
	/** A delete of this file was not answered; held until the person chooses. */
	let deletion = $state<string | undefined>();
	/** The file as shown for deletion, kept above any view until confirmed or cancelled. */
	let deletionReview = $state.raw<DeletionReview | undefined>();
	/** Why the last deletion did not happen. */
	let deletionProblem = $state<string | undefined>();
	/** The confirmed delete is being sent: it is admitted and cannot be called off. */
	let removing = $state(false);
	/** Each review is its own; a review that comes back late is dropped. */
	let reviewing: object | undefined;
	let view = $state<DraftView>('capture');
	/** Let go for good: nothing is taken or submitted again. */
	let retired = $state(false);

	const documentOf = memo((text: string) => {
		const { parseError } = store.inspect(text);
		return parseError === undefined
			? parseCapture(text)
			: unparsedCapture(text, parseError.message);
	});
	const readingOf = memo((text: string) => store.inspect(text));

	/** The editor's text now, valid or not: what Source shows and every view reads. */
	const source = () => editor?.row.text ?? '';
	const document = (): CaptureDocument => documentOf(source());

	// --- Admission ------------------------------------------------------

	/** Whether a person's input or action is taken now. */
	const admitted = () => !retired && operation === undefined && !store.fenced();

	/** Refuse a person's input, saying why when there is something to say. */
	function fenced(): boolean {
		if (admitted()) return false;
		if (operation === 'deleting')
			refusal = 'This capture is being deleted, so nothing typed is taken.';
		return true;
	}

	/**
	 * Refuse input for the file itself while a delete is unanswered: the file
	 * may be gone, and the person chooses what happens to it first.
	 */
	function undecided(): boolean {
		if (fenced()) return true;
		if (deletion === undefined) return false;
		refusal =
			'The delete was not confirmed. Choose what happens to this capture first.';
		return true;
	}

	const hasUnsentInput = () =>
		newThought !== '' || editing !== undefined || pendingText !== undefined;

	function notice(): Notice | undefined {
		if (deletion !== undefined) return { kind: 'deletion', message: deletion };
		const save = editor?.save;
		if (save?.status === 'failed') {
			const { error } = save;
			if (error.name === 'Unconfirmed')
				return { kind: 'unconfirmed', message: error.message };
			return {
				kind: 'failed',
				message: error.message,
				missing: error.name === 'NotFound',
			};
		}
		if (absent) return { kind: 'removed' };
		return undefined;
	}

	const unsettled = () =>
		hasUnsentInput() ||
		notice() !== undefined ||
		(operation !== undefined && operation !== 'opening') ||
		editor?.save.status === 'saving';

	/** Input went to the editor: what the last reload found is no longer the question. */
	function tookInput() {
		absent = false;
		refusal = undefined;
	}

	// --- The editor's lifetime -------------------------------------------

	/** Run `task` as this capture's admitted file work. */
	function admit<T>(task: () => Promise<T>): Promise<T> {
		const running = task();
		const tracked = running.then(noop, noop);
		work.add(tracked);
		void tracked.then(() => work.delete(tracked));
		return running;
	}

	/** Wait until no admitted file work is running, including work admitted meanwhile. */
	async function drainWork() {
		while (work.size > 0) await Promise.all(work);
	}

	/** Acquire the editor under the opening hold. A refusal stays visible. */
	async function open(): Promise<void> {
		operation = 'opening';
		const controller = new AbortController();
		opening = controller;
		try {
			await admit(async () => {
				try {
					const { data, error } = await store.edit(controller.signal);
					// Let go while it opened: nothing is installed.
					if (retired || controller.signal.aborted) return;
					if (error !== null)
						refused = {
							missing: error.name === 'NotFound',
							message: error.message,
						};
					else editor = fromRowEditor(data);
				} catch (cause) {
					if (!retired && !controller.signal.aborted)
						refused = { missing: false, message: describe(cause) };
				}
			});
		} finally {
			opening = undefined;
			if (operation === 'opening') operation = undefined;
			opened = true;
		}
	}

	/**
	 * Hold the capture for `task`, its admitted file work. The hold begins
	 * before anything is awaited. Resolves `undefined` when the capture is
	 * busy or fenced.
	 */
	async function hold<T>(
		kind: Exclude<Operation, 'opening' | 'deleting'>,
		task: (current: CaptureEditor) => Promise<T>,
	): Promise<T | undefined> {
		const current = editor;
		if (!admitted() || !current) return undefined;
		operation = kind;
		try {
			return await admit(() => task(current));
		} finally {
			if (operation === kind) operation = undefined;
		}
	}

	// --- Deletion --------------------------------------------------------

	/** Release the deletion hold, saying why when it did not delete. */
	function endDeletion(problem?: string) {
		deletionReview = undefined;
		deletionProblem = problem;
		reviewing = undefined;
		if (operation === 'deleting') operation = undefined;
	}

	/** Read the file for review, unless this review was called off meanwhile. */
	async function readForDeletion(
		token: object,
		problem: string | undefined,
	): Promise<boolean> {
		let current: Current;
		try {
			current = await store.read();
		} catch (cause) {
			if (reviewing === token) endDeletion(describe(cause));
			return false;
		}
		if (reviewing !== token || retired) return false;
		if (current.kind === 'present') {
			deletionReview = { entry: current.entry, problem };
			return true;
		}
		endDeletion(
			current.kind === 'removed'
				? 'This capture is already gone.'
				: current.message,
		);
		return false;
	}

	// --- Structured input -------------------------------------------------

	/**
	 * Submit a structured edit at once as the complete row: the fields the row
	 * has, unknown keys included, and the edited body. A refusal submits
	 * nothing and says why.
	 */
	function apply(edit: Edit): boolean {
		if (undecided()) return false;
		if (!editor || editor.row.status !== 'valid') {
			refusal = 'This capture cannot be edited here now.';
			return false;
		}
		if (!edit.ok) {
			refusal = edit.refusal.message;
			return false;
		}
		refusal = undefined;
		if (edit.source === editor.row.text) return true;
		const frame = frameRowText(edit.source);
		if (frame.kind !== 'frontmatter') {
			refusal = 'The edited capture has no frontmatter.';
			return false;
		}
		const { error } = editor.set({
			fields: editor.row.fields,
			body: edit.source.slice(frame.bodyStart),
		});
		if (error !== null) {
			refusal = error.message;
			return false;
		}
		tookInput();
		return true;
	}

	/** Let go for good. Admitted saves finish without anything held here. */
	function retire() {
		if (retired) return;
		retired = true;
		opening?.abort();
		editor = undefined;
	}

	const ready = open();

	return {
		path,
		stem,
		/** Settles once acquisition has an editor or a reason it has none. */
		ready,
		/** Acquisition settled. */
		get opened() {
			return opened;
		},
		/** The work holding this capture now, if any. */
		get operation() {
			return operation;
		},
		/** Let go for good: nothing is taken again. */
		get retired() {
			return retired;
		},
		/** Whether a person's input is taken now. */
		get admitted() {
			return admitted();
		},

		/** Whether the editor is acquired: Capture and Source can show its row. */
		get loaded() {
			return editor !== undefined;
		},
		/** The editor's row status, or `undefined` while there is no editor. */
		get status() {
			return editor?.row.status;
		},
		/** Why readable text has no structured form, when it has none. */
		get rowProblem(): string | undefined {
			return editor?.row.status === 'invalid'
				? describeRowError(editor.row.error)
				: undefined;
		},
		/** Why there is no editor, when acquisition gave none. */
		get refused() {
			return refused;
		},
		/** The text Source shows, and what a copy or a download holds. */
		get source() {
			return source();
		},
		/** That text read as text and thoughts. Thoughts belong to this value. */
		get document(): CaptureDocument {
			return document();
		},
		/** That text read as a row: a parse failure, or its fields and their issues. */
		get reading() {
			return readingOf(source());
		},
		/** The Capture view's controls apply: a valid row. */
		get structured() {
			return editor?.row.status === 'valid';
		},
		get view() {
			return view;
		},
		/** Choose Capture or Source. The choice outlives the view and changes nothing saved. */
		setView(next: DraftView) {
			if (fenced()) return;
			view = next;
		},
		/** What saving waits on the person for. */
		get notice() {
			return notice();
		},
		get saving() {
			return editor?.save.status === 'saving';
		},
		get refusal() {
			return refusal;
		},
		/** Whether leaving now would lose something. */
		get unsettled() {
			return unsettled();
		},
		get hasUnsentInput() {
			return hasUnsentInput();
		},

		/** Type in Source: submitted at once, exactly as typed, valid or not. */
		inputSource(value: string) {
			if (undecided() || !editor) return;
			const current = source();
			const next = fromTextarea(current, value, documentOf(current).newline);
			if (next === current) return;
			editor.setText(next);
			tookInput();
		},

		/**
		 * The capture text as the text box shows it: what was typed while it
		 * could not be applied, otherwise the document's text.
		 */
		get text() {
			return pendingText ?? document().text ?? '';
		},
		get textIsPending() {
			return pendingText !== undefined;
		},
		/** Type in the capture text box. Text that cannot be applied yet is kept. */
		inputText(value: string) {
			if (fenced()) return;
			if (apply(setText(document(), value))) pendingText = undefined;
			else pendingText = value;
		},
		dropPendingText() {
			if (fenced()) return;
			pendingText = undefined;
			refusal = undefined;
		},

		get newThought() {
			return newThought;
		},
		inputNewThought(value: string) {
			if (fenced()) return;
			newThought = value;
		},
		/** Add the new-thought text as the last thought. The text stays if refused. */
		addThought(): boolean {
			if (fenced()) return false;
			if (!apply(addThought(document(), newThought))) return false;
			newThought = '';
			return true;
		},

		get editing() {
			return editing;
		},
		/** Begin an edit of `thought`: a new edit, even of the thought edited before. */
		startEditing(thought: Thought) {
			if (fenced()) return;
			editing = { thought, text: thought.text, id: {} };
			refusal = undefined;
		},
		/** Type into the edit `id`; refused unless that is the edit open now. */
		inputEditing(text: string, id: ThoughtEdit['id']) {
			if (fenced() || editing?.id !== id) return;
			editing = { ...editing, text };
		},
		/**
		 * Apply the edit `id`. Refused unless that is the edit open now, and,
		 * with the text kept, if the capture changed since it began.
		 */
		commitEditing(id: ThoughtEdit['id']): boolean {
			if (fenced() || editing?.id !== id) return false;
			if (!apply(editThought(document(), editing.thought, editing.text)))
				return false;
			editing = undefined;
			return true;
		},
		/** Drop the edit `id`, unless another edit is open now. */
		cancelEditing(id: ThoughtEdit['id']) {
			if (fenced() || editing?.id !== id) return;
			editing = undefined;
			refusal = undefined;
		},
		deleteThought: (thought: Thought) =>
			!fenced() && apply(deleteThought(document(), thought)),
		swapThoughts: (thought: Thought, neighbour: Thought) =>
			!fenced() && apply(swapThoughts(document(), thought, neighbour)),

		/**
		 * Send the latest input again after a failed or unconfirmed save. A new
		 * attempt over whatever the file holds; it never confirms an earlier
		 * one, and a file that is gone is not created by it.
		 */
		retry() {
			if (undecided() || !editor) return;
			editor.retry();
			tookInput();
		},
		/**
		 * Read the file and show it, in place of this window's input. Waits for
		 * a save being sent; a failed save's input is dropped. Input typed while
		 * it reads is kept and nothing is loaded. Resolves whether it loaded.
		 */
		async reload(): Promise<boolean> {
			const current = editor;
			if (fenced() || !current) return false;
			const { error } = await current.reload();
			if (retired || editor !== current) return false;
			if (error === null) {
				absent = false;
				deletion = undefined;
				refusal = undefined;
				return true;
			}
			if (error.name === 'NotFound') {
				absent = true;
				refusal = undefined;
			} else if (error.name === 'InputChanged')
				refusal =
					'You typed while the file was being read, so it was not loaded. Your text is kept.';
			else
				refusal = `The file could not be read, so nothing was loaded. Your text is kept. ${error.message}`;
			return false;
		},
		/**
		 * Put a file that is not in the folder back from the editor's text with
		 * an exclusive create, then reload it. Text a file cannot hold exactly
		 * is refused before anything is written. A file found there instead is
		 * left as it is.
		 */
		async restore(): Promise<{ ok: true } | { ok: false; message: string }> {
			type Restored = { ok: true } | { ok: false; message: string };
			const result = await hold(
				'restoring',
				async (current): Promise<Restored> => {
					await current.flush();
					const text = current.row.text;
					if (!text.isWellFormed()) return { ok: false, message: UNENCODABLE };
					let written: Written;
					try {
						written = await store.create(text);
					} catch (cause) {
						return { ok: false, message: describe(cause) };
					}
					if (written.error !== null)
						return {
							ok: false,
							message:
								written.error.name === 'Exists'
									? 'A file is at this name, so nothing was written.'
									: written.error.message,
						};
					// The file holds exactly this text; reloading takes it as saved.
					absent = false;
					deletion = undefined;
					refusal = undefined;
					const { error } = await current.reload();
					if (error !== null)
						return {
							ok: false,
							message: `The file was put back but could not be read again: ${error.message}`,
						};
					return { ok: true };
				},
			);
			return result ?? { ok: false, message: 'This capture is busy.' };
		},

		/** The file as shown for deletion, while the person decides. */
		get deletionReview() {
			return deletionReview;
		},
		/** Why the last deletion did not happen. */
		get deletionProblem() {
			return deletionProblem;
		},
		/** A confirmed delete is being sent. */
		get removing() {
			return removing;
		},
		/**
		 * Hold the capture, wait for its saves, and read its file as it is now
		 * for the person to review before deleting it. The review is kept here,
		 * above any view, until `confirmDeletion` or `cancelDeletion`. Resolves
		 * whether there is a file to review.
		 */
		async reviewDeletion(): Promise<boolean> {
			const current = editor;
			if (!admitted() || !current) return false;
			operation = 'deleting';
			deletionProblem = undefined;
			const token = {};
			reviewing = token;
			return admit(async () => {
				await current.flush();
				return readForDeletion(token, undefined);
			});
		},
		/**
		 * Delete exactly the file the person reviewed, without reading it first.
		 * Refused while leaving or closing. Done, the capture is let go. If it
		 * changed since, the file as it is now is shown for another review.
		 * With no answer, the file may or may not be gone: the capture is kept
		 * and nothing writes the file until the person chooses.
		 */
		async confirmDeletion(): Promise<boolean> {
			const shown = deletionReview;
			if (operation !== 'deleting' || shown === undefined || removing)
				return false;
			if (retired || store.fenced()) {
				deletionReview = {
					entry: shown.entry,
					problem:
						'Nothing is deleted while Epicenter is closing this window. Cancel, or wait.',
				};
				return false;
			}
			const token = reviewing ?? {};
			removing = true;
			return admit(async () => {
				let failure: Failure;
				try {
					const { error } = await store.remove(shown.entry);
					if (error === null) {
						endDeletion();
						retire();
						return true;
					}
					failure = error;
				} catch (cause) {
					failure = { name: 'Unconfirmed', message: describe(cause) };
				} finally {
					removing = false;
				}
				if (failure.name === 'Conflict') {
					await readForDeletion(
						token,
						'This capture changed since you reviewed it. Review it again before deleting.',
					);
					return false;
				}
				if (failure.name === 'Unconfirmed') {
					deletion = failure.message;
					endDeletion();
					return false;
				}
				endDeletion(failure.message);
				return false;
			});
		},
		/** Keep the capture: the review is dropped and input is taken again. A delete being sent is not called off. */
		cancelDeletion() {
			if (operation !== 'deleting' || removing) return;
			endDeletion();
		},

		/**
		 * Hold the capture for a copy of its text: wait for its saves, then run
		 * `task` with the text as it is in Source. Resolves `undefined` when the
		 * capture is busy.
		 */
		copying<T>(task: (source: string) => Promise<T>): Promise<T | undefined> {
			return hold('copying', async (current) => {
				await current.flush();
				return task(current.row.text);
			});
		},

		/**
		 * For leaving and closing: wait for admitted file work, then for every
		 * accepted write. A failed save is not sent again, and a choice waiting
		 * for the person is not waited for. Resolves whether nothing here is
		 * unsettled.
		 */
		async settle(): Promise<boolean> {
			await drainWork();
			await editor?.flush();
			await drainWork();
			return !unsettled();
		},
		/** Let go for good: admitted saves finish, and nothing is taken or submitted again. */
		retire,
	};
}
