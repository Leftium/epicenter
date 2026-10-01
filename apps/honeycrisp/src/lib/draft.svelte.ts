/**
 * One file's draft: what is saved, what is typed, what is being saved, and
 * what another writer did meanwhile. These are four separate facts:
 *
 * - `accepted` is the saved source and version this draft last agreed with.
 *   The next conditional save is checked against it.
 * - `buffer` is the text on screen, including unsaved typing.
 * - `inFlight` is the exact text a running save captured. Its completion
 *   acknowledges that text only; typing after the capture stays dirty.
 * - `external` is a version of the file observed on disk that this draft has
 *   not agreed with: changed, removed, or unreadable. While it is set,
 *   autosave is paused and nothing is written until a person chooses.
 *
 * A clean draft adopts an external change by replacing its buffer; it writes
 * nothing back. A dirty draft never loses its buffer to an observation, a
 * failed save, or a refused one. Git outcomes never reach this state.
 *
 * The condition a save checks is the file boundary's: on a native folder it
 * compares the bytes it reads just before replacing them, which another
 * program can still race. A refusal is detected staleness, not a guarantee
 * that every stale save is refused.
 */
import { type FileVersion, sameVersion } from '@epicenter/app/files';
import type { Result } from 'wellcrafted/result';

/** One saved text file as its draft last accepted it. */
export type SavedText = {
	readonly path: string;
	readonly source: string;
	readonly version: FileVersion;
};

/** What a fresh read of the path found. */
export type Observed<T> =
	| { readonly kind: 'present'; readonly file: T }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

/** A version on disk the draft has not agreed with. */
export type External<T> =
	| { readonly kind: 'changed'; readonly current: T }
	| { readonly kind: 'removed' }
	| { readonly kind: 'unreadable'; readonly message: string };

export type DraftStore<T extends SavedText> = {
	/** One conditional write of `source` over exactly `accepted`. */
	write(
		accepted: T,
		source: string,
	): Promise<Result<T, { readonly name: string; readonly message: string }>>;
	/** A fresh read, for conflict review and after a save that raced an observation. */
	read(path: string): Promise<Observed<T>>;
};

export type DraftPhase = 'saved' | 'dirty' | 'saving' | 'failed' | 'conflict';

/** What an observation did to the draft. */
export type ObserveOutcome =
	| 'same'
	| 'adopted'
	| 'conflict'
	/** The file is gone and the draft held nothing unsaved; the owner may forget it. */
	| 'gone'
	/** A save is running; the path is read again when it settles. */
	| 'deferred';

/** Typing batches for this long before a save. */
const TYPING_BATCH_MS = 500;

export type Draft<T extends SavedText> = ReturnType<typeof createDraft<T>>;

export function createDraft<T extends SavedText>(
	store: DraftStore<T>,
	initial: T,
	{
		onSaved = () => {},
		batchMs = TYPING_BATCH_MS,
	}: {
		onSaved?: () => void;
		/** `null` disables the autosave timer; saves then run only when asked. */
		batchMs?: number | null;
	} = {},
) {
	let accepted = $state.raw<T>(initial);
	let buffer = $state(initial.source);
	let inFlight = $state.raw<{ readonly source: string } | undefined>();
	let external = $state.raw<External<T> | undefined>();
	let failure = $state<string | undefined>();
	let refusal = $state<string | undefined>();
	/** Counts buffer replacements from disk, so a view can drop stale undo history. */
	let adoptions = $state(0);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let saving: Promise<void> | undefined;
	let recheck = false;

	const dirty = () => buffer !== accepted.source;

	function schedule() {
		clearTimeout(timer);
		if (batchMs === null || external !== undefined) return;
		timer = setTimeout(() => void save(), batchMs);
	}

	function adopt(next: T) {
		accepted = next;
		buffer = next.source;
		external = undefined;
		failure = undefined;
		refusal = undefined;
		adoptions += 1;
	}

	function apply(observed: Observed<T>): ObserveOutcome {
		if (observed.kind === 'present') {
			const next = observed.file;
			if (next.path !== accepted.path) return 'same';
			if (sameVersion(next.version, accepted.version)) {
				// The same bytes: refresh metadata, and a conflict whose other side
				// went back to what this draft agreed with is over.
				accepted = next;
				if (external !== undefined) {
					external = undefined;
					if (dirty()) schedule();
				}
				return 'same';
			}
			if (!dirty()) {
				clearTimeout(timer);
				adopt(next);
				return 'adopted';
			}
			clearTimeout(timer);
			external = { kind: 'changed', current: next };
			return 'conflict';
		}
		clearTimeout(timer);
		if (observed.kind === 'removed') {
			if (!dirty()) return 'gone';
			external = { kind: 'removed' };
			return 'conflict';
		}
		external = { kind: 'unreadable', message: observed.message };
		return 'conflict';
	}

	async function saveOnce() {
		const captured = buffer;
		const expected = accepted;
		inFlight = { source: captured };
		failure = undefined;
		let result: Awaited<ReturnType<DraftStore<T>['write']>>;
		try {
			result = await store.write(expected, captured);
		} catch (cause) {
			result = {
				data: null,
				error: {
					name: 'Thrown',
					message: cause instanceof Error ? cause.message : String(cause),
				},
			};
		}
		inFlight = undefined;
		if (result.error === null) {
			// Only the captured text is acknowledged. `buffer` is not touched, so
			// typing that arrived during the save is still dirty.
			accepted = result.data;
			onSaved();
		} else if (result.error.name === 'Conflict') {
			// The stale save was refused and wrote nothing. Show what is there now.
			recheck = false;
			const now = await store.read(expected.path);
			if (
				now.kind === 'present' &&
				sameVersion(now.file.version, accepted.version)
			)
				failure = result.error.message;
			else apply(now);
			return;
		} else {
			failure = result.error.message;
		}
		if (recheck) {
			recheck = false;
			apply(await store.read(accepted.path));
		}
	}

	/** Save the current buffer now. Resolves when no save is running. */
	async function save(): Promise<void> {
		clearTimeout(timer);
		if (external !== undefined) return;
		if (saving) {
			await saving;
			return dirty() && failure === undefined ? save() : undefined;
		}
		if (!dirty()) return;
		saving = saveOnce();
		try {
			await saving;
		} finally {
			saving = undefined;
		}
		if (dirty() && failure === undefined && external === undefined) schedule();
	}

	return {
		get accepted() {
			return accepted;
		},
		get buffer() {
			return buffer;
		},
		/** The text a running save captured, or undefined when none is running. */
		get inFlight() {
			return inFlight;
		},
		get external() {
			return external;
		},
		/** Why the last save failed; cleared by the next attempt. */
		get failure() {
			return failure;
		},
		/** Why the last structured change was refused; typing clears it. */
		get refusal() {
			return refusal;
		},
		get adoptions() {
			return adoptions;
		},
		get dirty() {
			return dirty();
		},
		get path() {
			return accepted.path;
		},
		get phase(): DraftPhase {
			if (inFlight !== undefined) return 'saving';
			if (external !== undefined) return 'conflict';
			if (failure !== undefined) return 'failed';
			return dirty() ? 'dirty' : 'saved';
		},
		/** Whether leaving now would lose something: typing, a running or failed save, or a conflict. */
		get unsettled() {
			return dirty() || inFlight !== undefined || external !== undefined;
		},
		/** Replace the whole buffer, as a source editor does. */
		input(text: string) {
			buffer = text;
			refusal = undefined;
			schedule();
		},
		/** Record that a requested change could not be applied; the buffer is unchanged. */
		refuse(reason: string) {
			refusal = reason;
		},
		save,
		/**
		 * Report a fresh read of this path. A clean draft adopts changed bytes
		 * without writing; a dirty one keeps its buffer and records the other
		 * version. While a save runs, the path is read again once it settles,
		 * because the observation may be that save's own write.
		 */
		observe(observed: Observed<T>): ObserveOutcome {
			if (inFlight !== undefined) {
				recheck = true;
				return 'deferred';
			}
			return apply(observed);
		},
		/** Conflict choice: discard my draft and load what is saved. */
		loadSaved() {
			if (external?.kind !== 'changed') return;
			clearTimeout(timer);
			adopt(external.current);
		},
		/** Conflict choice: save my draft over the version I was just shown. */
		async saveMine() {
			if (external?.kind !== 'changed') return;
			// The save is conditional on the reviewed version, so a newer change
			// is refused again instead of overwritten unseen.
			accepted = external.current;
			external = undefined;
			await save();
		},
		async retry() {
			failure = undefined;
			await save();
		},
		/** Settle pending input before the file is renamed, deleted, or closed. */
		async settle(): Promise<boolean> {
			await save();
			return !dirty() && inFlight === undefined && external === undefined;
		},
		/**
		 * Continue against another saved file: after a rename, or after the
		 * draft was written to a new path because its file was removed. The
		 * buffer is kept; it is dirty when it differs from `next`.
		 */
		rebase(next: T) {
			accepted = next;
			external = undefined;
			failure = undefined;
			if (dirty()) schedule();
		},
		dispose() {
			clearTimeout(timer);
		},
	};
}
