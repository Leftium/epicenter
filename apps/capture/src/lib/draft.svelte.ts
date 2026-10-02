/**
 * One capture's draft: the whole Markdown source as it is on screen.
 *
 * - `buffer` is the text on screen, including unsaved typing. `baseline` is
 *   the saved file the next conditional save is checked against. `document`
 *   is the buffer read as text and thoughts; structured controls are edits to
 *   the buffer through it.
 * - A save writes exactly the buffer it captured, against the baseline it
 *   captured. Success advances the baseline to the entry the store returns:
 *   the bytes that were sent, their hash, and how their text reads. That text
 *   is the captured buffer unless encoding replaced an unpaired surrogate; a
 *   buffer still at the captured text becomes it. Typing that arrived
 *   meanwhile stays dirty and saves next.
 * - That entry acknowledges the write. It is not a reading of the path, which
 *   another program may have changed since: only a reread says what is there.
 * - An observation of the saved file (from a reread of the folder) refreshes
 *   a clean draft. It never replaces unsaved input: a dirty draft keeps its
 *   buffer, stops saving, and shows the saved file beside explicit choices.
 * - An observation that arrives while a save is running may predate that
 *   save, so it is not trusted. The draft rereads its own file when the save
 *   settles and compares that.
 * - A save that fails, or a store that throws, keeps the buffer and the
 *   baseline for a retry. Git never affects any of this.
 *
 * A saved file that is gone and one that cannot be read are different facts:
 * only the first offers writing the draft back to that path.
 *
 * Unsent input is draft state too: the new-thought text, a thought being
 * edited, and capture text that could not be applied. `unsettled` counts all
 * of it, so leaving the page asks first.
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
import type { FileTable, TableSnapshot } from '@epicenter/folder';

export type CaptureEntry = TableSnapshot<CaptureFields>;

/** What is at the draft's path now. */
export type Current =
	| { readonly kind: 'present'; readonly entry: CaptureEntry }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

export type SaveState =
	| { readonly kind: 'saved' }
	| { readonly kind: 'saving' }
	| { readonly kind: 'failed'; readonly message: string }
	| {
			/** The saved file is not what this draft was based on. Saving is paused. */
			readonly kind: 'conflict';
			readonly current: Current;
	  };

type Failure = { readonly name: string; readonly message: string };
type Result<T> =
	| { readonly data: T; readonly error: null }
	| { readonly data: null; readonly error: Failure };

/**
 * Where a draft saves and rereads. Any method may throw; the draft keeps its
 * input. A write resolves the entry of the bytes it sent, read from nothing.
 */
export type DraftStore = {
	/**
	 * How the captures table reads source text. It reads nothing from the
	 * folder, so the draft asks it about the buffer as it is typed.
	 */
	inspect: FileTable<CaptureFields>['inspect'];
	/** One conditional write of exact source against a captured file. */
	write(baseline: CaptureEntry, source: string): Promise<Result<CaptureEntry>>;
	/** The saved file the baseline names, now. */
	read(baseline: CaptureEntry): Promise<Current>;
	/** Write the source at the baseline's path, which must be absent. */
	recreate(
		baseline: CaptureEntry,
		source: string,
	): Promise<Result<CaptureEntry>>;
};

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 600;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export type Draft = ReturnType<typeof createDraft>;

export function createDraft(
	store: DraftStore,
	initial: CaptureEntry,
	hooks: {
		/** A save, or a choice that wrote, reached the folder. */
		onSaved(entry: CaptureEntry): void;
		batchMs?: number;
	},
) {
	let baseline = $state.raw<CaptureEntry>(initial);
	let buffer = $state(initial.source);
	let saveState = $state.raw<SaveState>({ kind: 'saved' });
	/** Why the last structured change was refused; the next change clears it. */
	let refusal = $state<string | undefined>();
	let newThought = $state('');
	/** The thought being edited, bound to the parse it was shown from. */
	let editing = $state.raw<
		{ readonly thought: Thought; readonly text: string } | undefined
	>();
	/** Capture text typed but refused, kept until it applies or is dropped. */
	let pendingText = $state<string | undefined>();
	/**
	 * The saved file is gone and there was nothing unsaved: nothing to keep.
	 * Input taken afterwards ends this; see `retain`.
	 */
	let gone = $state(false);

	/**
	 * How the buffer reads, by the table's own interpreter. This describes the
	 * text on screen, saved or not; the saved file's reading is on `baseline`.
	 */
	const reading = $derived(store.inspect(buffer));
	// Text and thoughts are read only from a buffer that parses as a capture.
	const document = $derived(
		reading.parseError === undefined
			? parseCapture(buffer)
			: unparsedCapture(buffer, reading.parseError.message),
	);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let disposed = false;
	/** An observation arrived mid-save; reread once the save settles. */
	let recheck = false;
	const batchMs = hooks.batchMs ?? TYPING_BATCH_MS;

	const dirty = () => buffer !== baseline.source;
	/** Read fresh: awaited work reassigns the state behind the checker's back. */
	const isSaved = () => saveState.kind === 'saved';

	function schedule() {
		clearTimeout(timer);
		if (disposed || saveState.kind === 'conflict') return;
		timer = setTimeout(() => void save(), batchMs);
	}

	/**
	 * A draft that holds input is never gone. Input taken after the file was
	 * found removed is kept as any input over a removed file is: a conflict,
	 * with saving paused until the person chooses. Nothing is read or written.
	 */
	function retain() {
		if (!gone) return;
		gone = false;
		clearTimeout(timer);
		saveState = { kind: 'conflict', current: { kind: 'removed' } };
	}

	function input(source: string) {
		buffer = source;
		retain();
		schedule();
	}

	/** Take what is at the path now, as a reread reported it. */
	function accept(current: Current) {
		if (current.kind === 'present') {
			if (current.entry.sha256 === baseline.sha256) {
				baseline = current.entry;
				if (saveState.kind === 'conflict') {
					// The file is back to what this draft was based on.
					saveState = { kind: 'saved' };
					if (dirty()) schedule();
				}
				return;
			}
			if (!dirty() && saveState.kind !== 'failed') {
				baseline = current.entry;
				buffer = current.entry.source;
				saveState = { kind: 'saved' };
				return;
			}
		} else if (current.kind === 'removed' && !dirty() && !hasUnsentInput()) {
			// Nothing typed here would be lost with it. Unsent input keeps the
			// draft, as a conflict, until the person decides.
			clearTimeout(timer);
			gone = true;
			return;
		}
		clearTimeout(timer);
		saveState = { kind: 'conflict', current };
	}

	async function reread() {
		try {
			accept(await store.read(baseline));
		} catch (cause) {
			accept({ kind: 'unreadable', message: describe(cause) });
		}
	}

	/**
	 * One write of the buffer as it is now. Success advances the baseline to
	 * exactly what was sent, that text with that hash, whatever the path holds
	 * by now. That is a separate observation, and a reread takes it.
	 */
	async function saveOnce(
		write: (source: string) => Promise<Result<CaptureEntry>>,
	) {
		const captured = buffer;
		saveState = { kind: 'saving' };
		try {
			const result = await write(captured);
			if (result.error === null) {
				baseline = result.data;
				// The same text unless encoding replaced an unpaired surrogate.
				// Newer typing is a later generation and stays as typed.
				if (buffer === captured) buffer = baseline.source;
				saveState = { kind: 'saved' };
				hooks.onSaved(baseline);
			} else if (result.error.name !== 'Conflict') {
				saveState = { kind: 'failed', message: result.error.message };
				return;
			} else recheck = true;
		} catch (cause) {
			// A store that throws (its host went away mid-call) must not leave the
			// draft saving forever. The baseline and the input stay for a retry.
			saveState = { kind: 'failed', message: describe(cause) };
			return;
		}
		// The file was not what the write expected, the folder hinted while it
		// ran, or the write asked to be followed by a look: what was written is
		// acknowledged, and the file as it is now decides the rest.
		if (recheck) {
			recheck = false;
			if (saveState.kind === 'saving') saveState = { kind: 'saved' };
			await reread();
		}
	}

	/** Run one save to its end. Typing that arrived during it batches again. */
	async function run(write: (source: string) => Promise<Result<CaptureEntry>>) {
		if (disposed) return;
		saving = saveOnce(write);
		try {
			await saving;
		} finally {
			saving = undefined;
		}
		if (dirty() && isSaved()) schedule();
	}

	/** Run saves until nothing admitted is left. Stops at a conflict or a failure. */
	async function drain(): Promise<void> {
		clearTimeout(timer);
		if (saving) {
			await saving;
			return !disposed && dirty() && saveState.kind === 'saved'
				? drain()
				: undefined;
		}
		if (disposed || saveState.kind === 'conflict' || !dirty() || gone) return;
		await run((source) => store.write(baseline, source));
	}

	async function save(): Promise<void> {
		await drain();
	}

	/** Apply a structured edit to the buffer, or record why it was refused. */
	function apply(edit: Edit): boolean {
		if (!edit.ok) {
			refusal = edit.refusal.message;
			return false;
		}
		refusal = undefined;
		if (edit.source !== buffer) input(edit.source);
		return true;
	}

	// Any typed character counts, spaces included: only the person discards it.
	const hasUnsentInput = () =>
		newThought !== '' || editing !== undefined || pendingText !== undefined;

	return {
		get baseline() {
			return baseline;
		},
		get path() {
			return baseline.path;
		},
		get buffer() {
			return buffer;
		},
		/** The buffer read as text and thoughts. Thoughts belong to this value. */
		get document(): CaptureDocument {
			return document;
		},
		/** The buffer read as a row: a parse failure, or its fields and their issues. */
		get reading() {
			return reading;
		},
		get saveState() {
			return saveState;
		},
		get refusal() {
			return refusal;
		},
		get dirty() {
			return dirty();
		},
		get gone() {
			return gone;
		},
		/** Whether leaving now would lose something. */
		get unsettled() {
			return (
				!gone && (dirty() || saveState.kind !== 'saved' || hasUnsentInput())
			);
		},
		get hasUnsentInput() {
			return hasUnsentInput();
		},

		/** Replace the whole source from a textarea, keeping untouched line endings. */
		inputSource(value: string) {
			const next = fromTextarea(buffer, value, document.newline);
			refusal = undefined;
			if (next !== buffer) input(next);
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
		/** Type in the capture text box. Text that cannot be applied yet is kept. */
		inputText(value: string) {
			const edit = setText(document, value);
			if (apply(edit)) pendingText = undefined;
			else {
				pendingText = value;
				retain();
			}
		},
		dropPendingText() {
			pendingText = undefined;
			refusal = undefined;
		},

		get newThought() {
			return newThought;
		},
		set newThought(value: string) {
			newThought = value;
			if (value !== '') retain();
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
			editing = { thought, text: thought.text };
			refusal = undefined;
			retain();
		},
		inputEditing(text: string) {
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
			editing = undefined;
			refusal = undefined;
		},
		deleteThought: (thought: Thought) =>
			apply(deleteThought(document, thought)),
		swapThoughts: (thought: Thought, neighbour: Thought) =>
			apply(swapThoughts(document, thought, neighbour)),

		save,
		/**
		 * The saved file as a reread of the folder found it. Ignored while a
		 * save is running: the draft rereads its own file when that settles.
		 */
		observe(current: Current) {
			if (gone) return;
			if (saving) {
				recheck = true;
				return;
			}
			accept(current);
		},
		/** Read the saved file again, after any running save. */
		async check() {
			if (saving) {
				recheck = true;
				await saving;
				return;
			}
			await reread();
		},

		/** Conflict choice: drop my input and show the saved file. */
		loadSaved() {
			if (saveState.kind !== 'conflict' || saveState.current.kind !== 'present')
				return;
			baseline = saveState.current.entry;
			buffer = baseline.source;
			pendingText = undefined;
			editing = undefined;
			refusal = undefined;
			saveState = { kind: 'saved' };
		},
		/**
		 * Conflict choice: save my draft over the saved file I was shown. It is
		 * checked against that file, so a further change conflicts again. When
		 * the file was removed, the draft is written back to its path, which
		 * must still be absent. Another program is at work on that path, so the
		 * write back is followed by one read of it before this resolves: what
		 * the file holds by then is adopted or shown here, not at a later refresh.
		 */
		async saveMine() {
			if (saveState.kind !== 'conflict' || saving) return;
			const { current } = saveState;
			if (current.kind === 'unreadable') return;
			if (current.kind === 'present') {
				baseline = current.entry;
				saveState = { kind: 'saved' };
				await save();
				return;
			}
			await run(async (source) => {
				const created = await store.recreate(baseline, source);
				if (created.error === null) recheck = true;
				return created;
			});
		},
		async retry() {
			if (saveState.kind === 'failed') saveState = { kind: 'saved' };
			await save();
		},
		/** Failed-save choice: drop my input and go back to the last saved file. */
		discardMine() {
			if (saveState.kind !== 'failed') return;
			buffer = baseline.source;
			pendingText = undefined;
			editing = undefined;
			refusal = undefined;
			saveState = { kind: 'saved' };
		},
		/** Save what can be saved now. Resolves whether nothing is left unsettled. */
		async settle(): Promise<boolean> {
			await drain();
			return (
				gone || (!dirty() && saveState.kind === 'saved' && !hasUnsentInput())
			);
		},
		/** Stop future saves and await only the save already submitted. */
		async dispose() {
			disposed = true;
			clearTimeout(timer);
			await saving;
		},
	};
}
