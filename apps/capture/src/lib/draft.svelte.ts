/**
 * One open capture: who owns its text, and every piece of work on its file.
 *
 * Exactly one owner holds the capture's text at a time:
 *
 * - `editing`: the folder's row editor. It owns the structured draft, the
 *   baseline it is dirty against, the latest read of the file, and each save.
 *   A save writes the complete canonical file whatever the file holds, and
 *   input typed during it stays dirty against the receipt.
 * - `raw`: exact source this window holds instead, for a file that cannot
 *   open as a row or after a Source edit of the frontmatter. No editor runs,
 *   so nothing follows the file. A raw write replaces only the version of the
 *   file the person was shown, and only when they ask.
 *
 * Every acquisition, save, raw write, settlement, deletion, and the final
 * disposal runs on one tracked chain, one at a time. Disposal and deletion
 * close a gate first, so no new work starts, then wait for the chain.
 *
 * This module decides when to save and what a person is shown:
 *
 * - Typing saves after a short pause. Saving stops, and the person chooses,
 *   while there is unsaved text and the file holds other content than this
 *   window saved or followed; while the file is not a valid capture or cannot
 *   be read; and after a save failed or was not confirmed. An unconfirmed save
 *   stays unknown even when a later read finds its text. Only the person's
 *   explicit choice releases the pause: Try again sends the document again,
 *   and taking the saved file acknowledges that outcome without calling it
 *   saved.
 * - A file removed elsewhere is written back by the next save.
 * - Structured controls change the body through `@epicenter/capture`. A Source
 *   edit that keeps the frontmatter is a body change too.
 *
 * Unsent input is draft state too: the new-thought text, a thought being
 * edited, capture text that could not be applied, and raw source not yet
 * written. They outlive changes of owner. `unsettled` counts all of it, so
 * leaving the page asks first.
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
	type FileCapture,
	type FileTable,
	frameSource,
	type RowEditor,
	type RowEditorState,
	type RowRevision,
	type RowSaveOutcome,
	type TableEditError,
	type TableSnapshot,
	type TextCapture,
} from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';

export type CaptureEntry = TableSnapshot<CaptureFields>;
export type CaptureEditor = RowEditor<CaptureFields>;

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
 * Where a draft opens its editor and writes raw source. Every method is
 * bound to the draft's own file. Any method may throw; the draft keeps its
 * input.
 */
export type DraftStore = {
	/** How the captures table reads source text. It reads nothing. */
	inspect: FileTable<CaptureFields>['inspect'];
	/** Open the row editor on the file. */
	edit(signal: AbortSignal): Promise<Result<CaptureEditor, TableEditError>>;
	/** The file now. */
	read(): Promise<Current>;
	/** Write exact source over the captured file, refused if it changed since. */
	replace(file: FileCapture, source: string): Promise<Written>;
	/** Write exact source where no file is. */
	create(source: string): Promise<Written>;
	/** Run a write, so a listing taken while it runs is taken again. */
	writing<T>(work: () => Promise<T>): Promise<T>;
};

/** Who holds the capture's text now. */
export type DraftMode =
	| { readonly kind: 'opening' }
	| { readonly kind: 'editing'; readonly editor: CaptureEditor }
	| {
			readonly kind: 'raw';
			readonly text: string;
			/**
			 * The version of the file a write replaces, as the person was shown
			 * it; `'absent'` when there is none. `'settling'` while a save
			 * admitted before the raw edit finishes: its receipt, or the version
			 * before it, is the version once it settles. Nothing is written
			 * while settling.
			 */
			readonly over: TextCapture | 'absent' | 'settling';
			/** Why the file could not open as a capture, when that is why it is raw. */
			readonly reason: string | undefined;
			/** Why the last raw write did not land. */
			readonly problem: string | undefined;
	  }
	/** No editor could be opened and no raw text is held. */
	| {
			readonly kind: 'unavailable';
			readonly missing: boolean;
			readonly message: string;
	  };

/**
 * Work on the file whose result the person has not answered: a save that did
 * not land or whose answer was lost, or a delete whose answer was lost.
 */
export type Outcome =
	/** The last save's answer was lost: it may or may not have landed. */
	| {
			readonly kind: 'unconfirmed';
			readonly message: string;
			/** The latest read holds this window's text. It confirms nothing. */
			readonly fileHoldsMine: boolean;
	  }
	| { readonly kind: 'failed'; readonly message: string }
	/**
	 * A delete was sent and no answer came back: the file may be gone. A
	 * later read showing it present or gone confirms nothing about the delete.
	 */
	| { readonly kind: 'deletion'; readonly message: string };

/** What the latest read of the file asks the person to review before saving. */
export type Review =
	/** Unsaved text, and the file holds other content than it is based on. */
	| { readonly kind: 'changed'; readonly revision: RowRevision }
	/** The file was changed into something that is not a valid capture. */
	| {
			readonly kind: 'invalid';
			readonly file: TextCapture;
			readonly message: string;
	  }
	/** The file cannot be read, so nothing may be saved over it. */
	| { readonly kind: 'unreadable'; readonly message: string };

/** Why saving stopped for a person's choice: an outcome or a review. */
export type Notice = Outcome | Review;

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 600;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

const captureOf = ({ path, sha256, source }: TextCapture): TextCapture => ({
	path,
	sha256,
	source,
});

const noop = () => {};

export type Draft = ReturnType<typeof createDraft>;

export function createDraft(
	store: DraftStore,
	{
		path,
		stem,
		initial,
	}: {
		readonly path: string;
		readonly stem: string;
		/** The listed file, shown until the editor opens. */
		readonly initial?: CaptureEntry;
	},
	hooks: {
		/** A save or a raw write reached the folder: this is what was written. */
		onSaved(entry: CaptureEntry): void;
		batchMs?: number;
	},
) {
	let mode = $state.raw<DraftMode>({ kind: 'opening' });
	/** The editor's state, only while the editor owns the text. */
	let editorState = $state.raw<RowEditorState<CaptureFields> | undefined>();
	/** Why the last structured change was refused; the next change clears it. */
	let refusal = $state<string | undefined>();
	let newThought = $state('');
	/** The thought being edited, bound to the parse it was shown from. */
	let editing = $state.raw<
		{ readonly thought: Thought; readonly text: string } | undefined
	>();
	/** Capture text typed but refused, kept until it applies or is dropped. */
	let pendingText = $state<string | undefined>();
	/** How many tracked operations are queued or running. */
	let working = $state(0);
	/** The folder threw instead of answering a save. */
	let thrown = $state<string | undefined>();
	/** A delete of this file was not answered; held until the person chooses. */
	let deletion = $state<string | undefined>();
	/**
	 * The save outcome the person answered by taking the saved file. It stays
	 * the editor's history; it only no longer holds saving back.
	 */
	let acknowledged = $state.raw<RowSaveOutcome | undefined>();
	/** Deletion or disposal is under way: no new work starts. */
	let gated = $state(false);
	/** Disposal began: an editor opened from now on is let go at once. */
	let retired = false;

	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The last tracked operation, settled; `undefined` when none is pending. */
	let tail: Promise<void> | undefined;
	let opening: AbortController | undefined;
	let disposal: Promise<void> | undefined;
	const batchMs = hooks.batchMs ?? TYPING_BATCH_MS;

	/**
	 * Run `operation` after every operation before it. With nothing pending it
	 * starts now, so a save captures the document as it is at the call.
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

	/** The text Source shows, and what a copy or a download holds. */
	const source = $derived(
		mode.kind === 'raw'
			? mode.text
			: (editorState?.source ??
					(mode.kind === 'opening' ? (initial?.source ?? '') : '')),
	);
	/** How that text reads as a row. */
	const reading = $derived(
		mode.kind === 'editing' && editorState !== undefined
			? editorState.reading
			: store.inspect(source),
	);
	// Text and thoughts are read only from text that parses as a capture.
	const document = $derived(
		reading.parseError === undefined
			? parseCapture(source)
			: unparsedCapture(source, reading.parseError.message),
	);

	const dirty = () =>
		mode.kind === 'editing' && (editorState?.isDirty ?? false);
	/** Raw text this window holds that the file, as last shown, does not. */
	const rawTyped = () =>
		mode.kind === 'raw' &&
		(typeof mode.over !== 'object' || mode.text !== mode.over.source);
	// Any typed character counts, spaces included: only the person discards it.
	const hasUnsentInput = () =>
		newThought !== '' || editing !== undefined || pendingText !== undefined;
	// An unanswered delete keeps even a clean draft: letting it go is a choice.
	const unsettled = () =>
		dirty() ||
		hasUnsentInput() ||
		rawTyped() ||
		deletion !== undefined ||
		working > 0 ||
		editorState?.saving !== undefined;

	// An outcome and a review are judged apart: an old outcome never hides
	// what the latest read found, and that read never hides that a save did
	// not land.
	const outcome = $derived.by((): Outcome | undefined => {
		if (deletion !== undefined) return { kind: 'deletion', message: deletion };
		if (mode.kind !== 'editing' || editorState === undefined) return;
		if (thrown !== undefined) return { kind: 'failed', message: thrown };
		const { observation } = editorState;
		// History: an answered outcome stays `lastSave`, and is no longer shown.
		const lastSave =
			editorState.lastSave === acknowledged ? undefined : editorState.lastSave;
		if (lastSave?.kind === 'failed')
			return { kind: 'failed', message: lastSave.error.message };
		if (lastSave?.kind === 'unconfirmed')
			return {
				kind: 'unconfirmed',
				message: lastSave.error.message,
				fileHoldsMine:
					observation.kind === 'present' &&
					observation.revision.canonical === editorState.source,
			};
	});
	const review = $derived.by((): Review | undefined => {
		if (mode.kind !== 'editing' || editorState === undefined) return;
		const { observation, isDirty, baseline } = editorState;
		switch (observation.kind) {
			case 'present':
				// A read from before this window's own save settled is not news.
				if (working > 0 || editorState.saving !== undefined) return;
				return isDirty && observation.revision.canonical !== baseline.canonical
					? { kind: 'changed', revision: observation.revision }
					: undefined;
			case 'missing':
				// The next save writes it back.
				return;
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
			default:
				return observation satisfies never;
		}
	});

	/** Whether typing may save without asking. Read fresh in timers. */
	const mayAutosave = () =>
		!gated &&
		mode.kind === 'editing' &&
		outcome === undefined &&
		review === undefined;

	function schedule() {
		clearTimeout(timer);
		if (!mayAutosave()) return;
		timer = setTimeout(() => void drain(), batchMs);
	}

	function entryOf(revision: RowRevision): CaptureEntry {
		return Object.freeze({
			path: revision.path,
			stem,
			source: revision.source,
			sha256: revision.sha256,
			...store.inspect(revision.source),
		});
	}

	/**
	 * One save of the whole document, then a read of the file, so what the
	 * file holds afterwards is known before saving is judged again. Resolves
	 * whether it landed.
	 */
	function save(editor: CaptureEditor): Promise<boolean> {
		clearTimeout(timer);
		return track(async () => {
			try {
				const { data: receipt, error } = await store.writing(() =>
					editor.save(),
				);
				if (error === null) {
					thrown = undefined;
					hooks.onSaved(entryOf(receipt));
					return true;
				}
				// Refused before anything was sent; a failure is in `lastSave`.
				if (error.name === 'InvalidDocument') refusal = error.message;
				return false;
			} catch (cause) {
				// Storage that throws is not an answer. The document stays dirty.
				thrown = describe(cause);
				return false;
			} finally {
				await editor.refresh();
			}
		});
	}

	/** Save until nothing unsaved is left, or saving stops for a choice. */
	async function drain(): Promise<void> {
		clearTimeout(timer);
		// With nothing pending, the save starts now, with the document as it is.
		if (tail) await idle();
		if (mode.kind !== 'editing' || !dirty() || !mayAutosave()) return;
		if (await save(mode.editor)) return drain();
	}

	function attach(editor: CaptureEditor) {
		mode = { kind: 'editing', editor };
		// A new editor has no outcome to answer for; an old throw is history.
		thrown = undefined;
		acknowledged = undefined;
		editor.subscribe((state) => {
			// A former editor's last states are not news.
			if (mode.kind === 'editing' && mode.editor === editor)
				editorState = state;
		});
	}

	/**
	 * Hold a file that has no row form as raw source. Raw text typed here is
	 * kept; untouched raw text becomes the file's.
	 */
	function holdRaw(file: TextCapture, reason: string) {
		const kept = mode.kind === 'raw' && rawTyped() ? mode.text : file.source;
		mode = {
			kind: 'raw',
			text: kept,
			over: captureOf(file),
			reason,
			problem: mode.kind === 'raw' ? mode.problem : undefined,
		};
	}

	function opened(error: TableEditError) {
		switch (error.name) {
			case 'NoCanonicalForm':
			case 'InvalidSource':
				holdRaw(error.file, error.message);
				return;
			default:
				// Raw text typed here outlives a file that is gone or unreadable.
				if (mode.kind === 'raw' && rawTyped()) {
					mode = { ...mode, problem: error.message };
					return;
				}
				mode = {
					kind: 'unavailable',
					missing: error.name === 'NotFound',
					message: error.message,
				};
		}
	}

	/**
	 * Open an editor on the file as it is now. Part of a tracked operation.
	 * Raw text typed meanwhile keeps its owner: the new editor is let go.
	 */
	async function acquire(): Promise<void> {
		opening?.abort();
		const controller = new AbortController();
		opening = controller;
		let result: Awaited<ReturnType<DraftStore['edit']>>;
		try {
			result = await store.edit(controller.signal);
		} catch (cause) {
			if (opening === controller) opening = undefined;
			if (retired) return;
			if (mode.kind === 'raw' && rawTyped())
				mode = { ...mode, problem: describe(cause) };
			else
				mode = { kind: 'unavailable', missing: false, message: describe(cause) };
			return;
		}
		if (opening === controller) opening = undefined;
		if (
			retired ||
			controller.signal.aborted ||
			(mode.kind === 'raw' && rawTyped())
		) {
			if (result.error === null) await result.data.dispose();
			return;
		}
		if (result.error !== null) opened(result.error);
		else attach(result.data);
	}

	/** Let the editor go now: it stops following the file at once. */
	function release(): Promise<void> | undefined {
		if (mode.kind !== 'editing') return;
		editorState = undefined;
		return mode.editor.dispose();
	}

	/** Raw text that replaces the editor's, from a Source edit of the frontmatter. */
	function enterRaw(editor: CaptureEditor, text: string) {
		clearTimeout(timer);
		mode = {
			kind: 'raw',
			text,
			over: 'settling',
			reason: undefined,
			problem: undefined,
		};
		editorState = undefined;
		const disposing = editor.dispose();
		// The editor stopped following the file above. Once a save it had
		// admitted settles, its baseline is the version this text replaces:
		// that save's receipt, or the version before an outcome that is not one.
		void track(async () => {
			try {
				await disposing;
			} catch (cause) {
				thrown = describe(cause);
			}
			const { baseline } = editor.get();
			if (mode.kind === 'raw' && mode.over === 'settling')
				mode = { ...mode, over: captureOf(baseline) };
		});
	}

	/**
	 * Write the raw source exactly over the version the person was shown, or
	 * where nothing is. A file that changed meanwhile is shown, and the text
	 * stays for another choice. Raw text typed during the write stays, now
	 * over what was written, for another explicit write.
	 */
	function writeRaw(): Promise<void> {
		if (gated || mode.kind !== 'raw') return Promise.resolve();
		return track(async () => {
			if (mode.kind !== 'raw' || mode.over === 'settling') return;
			const { text, over } = mode;
			try {
				const written =
					over === 'absent'
						? await store.create(text)
						: await store.replace(over, text);
				if (written.error === null) {
					hooks.onSaved(written.data);
					// The person chose to write the file; an unanswered delete is answered.
					deletion = undefined;
					if (mode.kind !== 'raw') return;
					if (mode.text !== text) {
						mode = { ...mode, over: captureOf(written.data), problem: undefined };
						return;
					}
					mode = { ...mode, over: captureOf(written.data), problem: undefined };
					if (!retired) await acquire();
					return;
				}
				const { error } = written;
				if (
					error.name !== 'Conflict' &&
					error.name !== 'Exists' &&
					error.name !== 'NotFound'
				) {
					if (mode.kind === 'raw') mode = { ...mode, problem: error.message };
					return;
				}
				const current = await store.read();
				if (mode.kind !== 'raw') return;
				if (current.kind === 'unreadable') {
					mode = { ...mode, problem: current.message };
					return;
				}
				mode = {
					...mode,
					over: current.kind === 'present' ? captureOf(current.entry) : 'absent',
					problem:
						current.kind === 'present'
							? 'The file changed outside this window, so this source was not saved. The file now is shown below; saving again replaces it.'
							: 'The file was removed outside this window, so this source was not saved. Saving again writes it back.',
				};
			} catch (cause) {
				if (mode.kind === 'raw') mode = { ...mode, problem: describe(cause) };
			}
		});
	}

	/** Apply a structured edit to the editor's body, or record why it was refused. */
	function apply(edit: Edit): boolean {
		if (fenced()) return false;
		if (mode.kind !== 'editing') {
			refusal =
				mode.kind === 'raw'
					? 'Source has text that is not saved yet. Save or discard it first.'
					: 'This capture cannot be edited here yet.';
			return false;
		}
		if (!edit.ok) {
			refusal = edit.refusal.message;
			return false;
		}
		const frame = frameSource(edit.source);
		if (frame.kind !== 'frontmatter') {
			refusal = 'The edited capture has no frontmatter.';
			return false;
		}
		const changed = mode.editor.change({
			body: edit.source.slice(frame.bodyStart),
		});
		if (changed.error !== null) {
			refusal = changed.error.message;
			return false;
		}
		refusal = undefined;
		schedule();
		return true;
	}

	/** Take the latest valid read in place of the draft, answering any outcome. */
	function takeSaved(): boolean {
		if (mode.kind !== 'editing' || editorState === undefined) return false;
		const { observation, lastSave } = editorState;
		if (observation.kind !== 'present') {
			refusal =
				'The file could not be read as a capture just now, so there is nothing to go back to. Check again first.';
			return false;
		}
		const adopted = mode.editor.adopt(observation.revision);
		if (adopted.error !== null) {
			refusal = adopted.error.message;
			return false;
		}
		acknowledged = lastSave;
		thrown = undefined;
		deletion = undefined;
		pendingText = undefined;
		editing = undefined;
		refusal = undefined;
		return true;
	}

	/** While a delete owns the file, nothing typed is taken. Says so. */
	function fenced(): boolean {
		if (!gated || retired) return gated;
		refusal = 'This capture is being deleted, so nothing typed is taken.';
		return true;
	}

	/**
	 * Close the gate and let go of the editor once every operation already
	 * admitted has settled. The editor's last state stays readable.
	 */
	function dispose(): Promise<void> {
		disposal ??= (async () => {
			gated = true;
			retired = true;
			clearTimeout(timer);
			opening?.abort();
			await idle();
			if (mode.kind === 'editing') await mode.editor.dispose().catch(noop);
		})();
		return disposal;
	}

	const ready = track(acquire);

	return {
		path,
		stem,
		/** Settles once the first opening has an editor or a reason it has none. */
		ready,
		/** Settles once no tracked operation is pending. */
		idle,
		get mode() {
			return mode;
		},
		/** The editor's state while it owns the text: baseline, latest read, last save. */
		get editor() {
			return editorState;
		},
		/** The text Source shows. */
		get source() {
			return source;
		},
		/** That text read as text and thoughts. Thoughts belong to this value. */
		get document(): CaptureDocument {
			return document;
		},
		/** That text read as a row: a parse failure, or its fields and their issues. */
		get reading() {
			return reading;
		},
		/** Structured controls apply: the editor owns the text. */
		get structured() {
			return mode.kind === 'editing';
		},
		/** A save that did not land or whose answer was lost, until the person answers it. */
		get outcome() {
			return outcome;
		},
		/** What the latest read of the file asks the person to review first. */
		get review() {
			return review;
		},
		/** The outcome, else the review: what a status line names first. */
		get notice(): Notice | undefined {
			return outcome ?? review;
		},
		get saving() {
			return working > 0 || editorState?.saving !== undefined;
		},
		/** A delete or disposal owns the file: no work starts and nothing typed is taken. */
		get gated() {
			return gated;
		},
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		/** The file is gone and nothing here would be lost with it. */
		get gone() {
			if (unsettled()) return false;
			if (mode.kind === 'unavailable') return mode.missing;
			return (
				mode.kind === 'editing' && editorState?.observation.kind === 'missing'
			);
		},
		/** Whether leaving now would lose something. */
		get unsettled() {
			return unsettled();
		},
		get hasUnsentInput() {
			return hasUnsentInput();
		},

		/**
		 * Type in Source. With the frontmatter as the editor has it, this is a
		 * body change. Any other text makes the source raw, written only on request.
		 */
		inputSource(value: string) {
			if (fenced()) return;
			refusal = undefined;
			if (mode.kind === 'raw') {
				const next = fromTextarea(mode.text, value, document.newline);
				if (next !== mode.text) mode = { ...mode, text: next, problem: undefined };
				return;
			}
			if (mode.kind !== 'editing' || editorState === undefined) return;
			const current = editorState.source;
			const next = fromTextarea(current, value, document.newline);
			if (next === current) return;
			const head = frameSource(current);
			const frame = frameSource(next);
			if (
				head.kind === 'frontmatter' &&
				frame.kind === 'frontmatter' &&
				next.slice(0, frame.bodyStart) === current.slice(0, head.bodyStart)
			) {
				const changed = mode.editor.change({
					body: next.slice(frame.bodyStart),
				});
				if (changed.error === null) {
					schedule();
					return;
				}
				refusal = changed.error.message;
			}
			enterRaw(mode.editor, next);
		},
		/** Write the raw source exactly. */
		writeRaw,
		/**
		 * Drop raw source typed here: back to the file as it was shown, then
		 * open it again as a capture when it is one.
		 */
		async discardRaw() {
			if (gated || mode.kind !== 'raw' || mode.over === 'settling') return;
			const { over } = mode;
			refusal = undefined;
			if (over === 'absent') {
				mode = { kind: 'unavailable', missing: true, message: 'The file is not in the folder.' };
				return;
			}
			mode = { ...mode, text: over.source, problem: undefined };
			await track(acquire);
		},

		/**
		 * The capture text as the text box shows it: what was typed while it
		 * could not be applied, otherwise the document's text.
		 */
		get text() {
			return pendingText ?? document.text ?? '';
		},
		get textIsPending() {
			return pendingText !== undefined;
		},
		/**
		 * Type in the capture text box. Text that cannot be applied yet is kept.
		 * While a delete owns the file, nothing typed is taken, kept or not.
		 */
		inputText(value: string) {
			if (fenced()) return;
			if (apply(setText(document, value))) pendingText = undefined;
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
		set newThought(value: string) {
			if (fenced()) return;
			newThought = value;
		},
		/** Add the new-thought text as the last thought. The text stays if refused. */
		addThought(): boolean {
			if (!apply(addThought(document, newThought))) return false;
			newThought = '';
			return true;
		},

		get editing() {
			return editing;
		},
		startEditing(thought: Thought) {
			if (fenced()) return;
			editing = { thought, text: thought.text };
			refusal = undefined;
		},
		inputEditing(text: string) {
			if (fenced()) return;
			if (editing) editing = { thought: editing.thought, text };
		},
		/** Apply the edit. Refused, with the text kept, if the capture changed since it began. */
		commitEditing(): boolean {
			if (!editing) return false;
			if (!apply(editThought(document, editing.thought, editing.text)))
				return false;
			editing = undefined;
			return true;
		},
		cancelEditing() {
			if (fenced()) return;
			editing = undefined;
			refusal = undefined;
		},
		deleteThought: (thought: Thought) =>
			apply(deleteThought(document, thought)),
		swapThoughts: (thought: Thought, neighbour: Thought) =>
			apply(swapThoughts(document, thought, neighbour)),

		/** Save what typing would save, now. */
		save: drain,
		/**
		 * The person's explicit save: a retry after a failure or an unknown
		 * outcome, keeping this draft over a change made elsewhere that is
		 * shown, or writing it back after a delete whose answer was lost. It
		 * sends the whole document again, even when it reads as saved. A file
		 * that cannot be read cannot be reviewed, so nothing is saved over it,
		 * whatever an earlier outcome was.
		 */
		async saveMine() {
			if (gated) return;
			await idle();
			if (gated || mode.kind !== 'editing') return;
			if (review?.kind === 'unreadable') {
				refusal =
					'The file cannot be read just now, so it cannot be reviewed and nothing is saved over it. Check again first.';
				return;
			}
			thrown = undefined;
			deletion = undefined;
			if ((await save(mode.editor)) && dirty()) schedule();
		},
		/** Changed-elsewhere choice: drop my input and take the file as it is now. */
		loadSaved() {
			if (review?.kind === 'changed') takeSaved();
		},
		/**
		 * Drop my input and take the file as last read, after a failed or
		 * unknown save. The outcome stays what it was; it no longer holds
		 * saving back.
		 */
		discardMine() {
			if (!gated && working === 0) takeSaved();
		},
		/**
		 * Edit the file as raw source, exactly as the latest read found it,
		 * dropping this window's draft. For a file changed into something that
		 * is not a valid capture.
		 */
		async repairFile() {
			if (gated || review?.kind !== 'invalid' || working > 0) return;
			const { file, message } = review;
			const disposing = release();
			mode = {
				kind: 'raw',
				text: file.source,
				over: captureOf(file),
				reason: message,
				problem: undefined,
			};
			pendingText = undefined;
			editing = undefined;
			refusal = undefined;
			await track(async () => {
				await disposing;
			});
		},
		/** Read the file again: through the editor, or by opening it again. */
		async check() {
			if (gated || mode.kind === 'opening') return;
			if (mode.kind === 'editing') await mode.editor.refresh();
			else if (!rawTyped()) await track(acquire);
		},

		/**
		 * Delete the file with `remove`, after every operation already admitted.
		 * No new work starts and nothing typed is taken meanwhile. Refused, the
		 * draft goes on; done, it is disposed and does nothing more. With no
		 * answer, thrown or `Unconfirmed`, the file may or may not be gone: the
		 * draft is kept, usable, and nothing writes it until the person saves it
		 * back, takes the file as it is, or lets the capture go.
		 */
		async remove<
			T extends {
				readonly error: { readonly name: string; readonly message: string } | null;
			},
		>(remove: () => Promise<T>): Promise<T> {
			gated = true;
			clearTimeout(timer);
			let removed: T;
			try {
				removed = await track(remove);
			} catch (cause) {
				if (!retired) gated = false;
				deletion = describe(cause);
				throw cause;
			}
			if (removed.error === null) {
				await dispose();
				return removed;
			}
			if (!retired) gated = false;
			if (removed.error.name === 'Unconfirmed') deletion = removed.error.message;
			else if (dirty()) schedule();
			return removed;
		},

		/** Save what can be saved now. Resolves whether nothing is left unsettled. */
		async settle(): Promise<boolean> {
			await drain();
			await idle();
			return !unsettled();
		},
		/** Stop all work once what was admitted settles. Repeated calls share one disposal. */
		dispose,
	};
}
