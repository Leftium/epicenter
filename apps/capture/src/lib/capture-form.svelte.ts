/**
 * The capture view's form over one open capture's row session: its text and
 * thoughts read from the draft's body, and the input the draft does not hold
 * yet.
 *
 * Every structured change composes the complete `{ text, thoughts }`,
 * encodes it over the current body (`captureBody.encode`), and edits the
 * draft, which saves at once. A change the body cannot hold exactly is
 * refused with the reason, and the draft is unchanged.
 *
 * A new thought and a thought being edited are typed here until they are
 * added or saved. Thoughts are selected by position, so a command names the
 * list it was shown and is refused when the list changed since; a thought
 * edit remembers the thought it started from and is refused, with its text
 * kept, when that thought changed.
 */
import {
	type CaptureBody,
	type CaptureFields,
	captureBody,
} from '@epicenter/capture';
import { type RowSession, wellFormed } from '@epicenter/svelte/edit-session';

/** One edit of a thought, from Edit until it is saved or cancelled. */
export type ThoughtEdit = {
	readonly index: number;
	/** The thought as it was when the edit started. */
	readonly original: string;
	readonly text: string;
	/** This edit's identity: a later edit, of the same thought or another, has its own. */
	readonly id: object;
};

export type CaptureForm = ReturnType<typeof createCaptureForm>;

export function createCaptureForm(session: RowSession<CaptureFields>) {
	let newThought = $state('');
	let editing = $state.raw<ThoughtEdit | undefined>();
	/** Why the last change was not taken; the next change clears it. */
	let refusal = $state<string | undefined>();

	/** The draft's body as text and thoughts, or why it cannot be read as one. */
	const reading = $derived(captureBody.decode(session.draft.body));
	const thoughts = () => reading.data?.thoughts ?? [];

	/** Encode a complete value over the draft's body and save it. */
	function write(value: CaptureBody): boolean {
		if (session.locked) return false;
		const { data: body, error } = captureBody.encode(value, session.draft.body);
		if (error !== null) {
			refusal = error.message;
			return false;
		}
		refusal = undefined;
		if (body !== session.draft.body)
			session.edit((row) => {
				row.body = body;
			});
		return true;
	}

	const text = () => reading.data?.text ?? '';

	return {
		session,
		/** The body as text and thoughts; `error` says why it cannot be edited here. */
		get reading() {
			return reading;
		},
		get text() {
			return text();
		},
		get thoughts() {
			return thoughts();
		},
		get refusal() {
			return refusal;
		},
		/** Typed here and not in the draft: a new thought, or a changed thought edit. */
		get unsent() {
			return (
				newThought !== '' ||
				(editing !== undefined && editing.text !== editing.original)
			);
		},

		/** Replace the capture text. A refused change leaves the draft's text. */
		inputText(value: string) {
			write({ text: wellFormed(value), thoughts: thoughts() });
		},

		get newThought() {
			return newThought;
		},
		inputNewThought(value: string) {
			if (!session.locked) newThought = value;
		},
		/** Add the new thought after the last one. The text stays if refused. */
		addThought(): boolean {
			if (session.locked) return false;
			if (newThought.trim() === '') {
				refusal = 'Write something first.';
				return false;
			}
			if (
				!write({
					text: text(),
					thoughts: [...thoughts(), wellFormed(newThought)],
				})
			)
				return false;
			newThought = '';
			return true;
		},

		get editing() {
			return editing;
		},
		/** Begin editing the thought at `index` of the list `shown`. */
		startEditing(index: number, shown: readonly string[]) {
			if (session.locked || shown !== thoughts()) return;
			const original = shown[index];
			if (original === undefined) return;
			editing = { index, original, text: original, id: {} };
			refusal = undefined;
		},
		/** Type into the edit `id`; refused unless that is the edit open now. */
		inputEditing(text: string, id: object) {
			if (session.locked || editing?.id !== id) return;
			editing = { ...editing, text };
		},
		/**
		 * Save the edit `id`. Refused, with its text kept, when the thought it
		 * started from is no longer at its position.
		 */
		commitEditing(id: object): boolean {
			if (session.locked || editing?.id !== id) return false;
			const { index, original, text: edited } = editing;
			const current = thoughts();
			if (current[index] !== original) {
				refusal =
					'This thought changed since you started editing it, so nothing was changed. Copy your text, then cancel.';
				return false;
			}
			if (edited.trim() === '') {
				refusal = 'A thought needs text. Delete it instead.';
				return false;
			}
			if (
				!write({
					text: text(),
					thoughts: current.map((thought, at) =>
						at === index ? wellFormed(edited) : thought,
					),
				})
			)
				return false;
			editing = undefined;
			return true;
		},
		cancelEditing(id: object) {
			if (editing?.id !== id) return;
			editing = undefined;
			refusal = undefined;
		},
		/** Delete the thought at `index` of the list `shown`. */
		deleteThought(index: number, shown: readonly string[]): boolean {
			if (shown !== thoughts() || shown[index] === undefined) return false;
			return write({
				text: text(),
				thoughts: shown.filter((_, at) => at !== index),
			});
		},
		/** Swap two neighbouring thoughts of the list `shown`. */
		swapThoughts(from: number, to: number, shown: readonly string[]): boolean {
			if (shown !== thoughts() || Math.abs(from - to) !== 1) return false;
			const next = [...shown];
			const first = next[from];
			const second = next[to];
			if (first === undefined || second === undefined) return false;
			next[from] = second;
			next[to] = first;
			return write({ text: text(), thoughts: next });
		},
	};
}
