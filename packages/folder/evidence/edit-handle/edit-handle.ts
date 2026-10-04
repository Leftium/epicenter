/**
 * EXPERIMENT: one framework-neutral edit handle over one saved document.
 *
 * This is evidence for a proposed API, not part of `@epicenter/folder`. The
 * question under test is whether one small engine can serve a vanilla DOM
 * caller, Solid's `from`, and Svelte's `createSubscriber` alike, while
 * keeping the folder's publication facts honest under concurrent writers.
 *
 * A handle keeps three values apart (ADR-0465, ADR-0484):
 *
 * - `baseline`: the saved capture the next save is conditional on. It moves
 *   only on a save receipt, an idle adoption, or an explicit resolution. A
 *   save never rereads to find a fresher one.
 * - `source`: the candidate text. Structured controls prepare a new candidate
 *   and `input` replaces it; `reading` is how the candidate reads.
 * - `incoming`: the latest observation that differs from the baseline, kept
 *   while the draft is dirty so a person can review it.
 *
 * Save timing, debouncing, and autosave belong to the caller (ADR-0485). The
 * handle saves once per `save()` call and never retries.
 *
 * The document it edits is supplied: `folder-edits.ts` builds one for a
 * folder's table row or text file, reading it through the folder, saving it
 * with a conditional `replace`, and watching the folder's change hints for
 * its path. This module imports no Markdown or storage code.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { FileCapture, TextCapture } from '../../src/capture.js';
import {
	FileError,
	type TableReadError,
	type TableReplaceError,
} from '../../src/errors.js';

/** What one read of the document found. Absence and unreadable bytes are different facts. */
export type Observation<TSnapshot> =
	| { readonly kind: 'present'; readonly snapshot: TSnapshot }
	| { readonly kind: 'missing' }
	| { readonly kind: 'unreadable'; readonly error: TableReadError };

/** Exactly what one save submitted, and the capture it was conditional on. */
export type SaveAttempt = {
	readonly source: string;
	readonly against: FileCapture;
};

/** How the latest settled save ended. */
export type SaveOutcome<TSnapshot> =
	| { readonly kind: 'saved'; readonly receipt: TSnapshot }
	/** The file was not the baseline at publication. Nothing was written and nothing retries. */
	| {
			readonly kind: 'conflict';
			readonly attempt: SaveAttempt;
			readonly error: Extract<FileError, { name: 'Conflict' }>;
	  }
	/**
	 * The reply was lost: the attempt may or may not have landed, and that
	 * stays unknown. Reading its text from the file later does not prove this
	 * request wrote it, so this record is never upgraded. Whatever the file
	 * holds afterward is an ordinary observation.
	 */
	| {
			readonly kind: 'unconfirmed';
			readonly attempt: SaveAttempt;
			readonly error: TableReplaceError;
	  }
	| {
			readonly kind: 'failed';
			readonly attempt: SaveAttempt;
			readonly error: TableReplaceError;
	  };

/** Why `save()` sent nothing. */
export type SaveRefusal = {
	readonly kind: 'refused';
	readonly reason: 'disposed' | 'saving' | 'clean';
};

/**
 * Why an edit, discard, or resolution changed nothing.
 *
 * - `saving`: a discard or resolution cannot cancel a write that is still
 *   admitted, so it is refused rather than made to look as if it did. Once
 *   the attempt settles, even as `unconfirmed`, both are allowed: the next
 *   save is conditional on the baseline, and the file's later content is
 *   observed like any other change.
 * - `otherPath`: the snapshot is not of this handle's file.
 */
export type EditRefusal = {
	readonly kind: 'refused';
	readonly reason: 'disposed' | 'saving' | 'otherPath';
};

export type EditState<TSnapshot extends TextCapture, TReading> = {
	readonly path: string;
	/** The saved capture the next save is conditional on. */
	readonly baseline: TSnapshot;
	/**
	 * The candidate: exactly what `save()` would submit. It is always
	 * well-formed text, so it equals the text of the bytes a save writes: a
	 * lone surrogate becomes U+FFFD when it is input, as UTF-8 encoding would
	 * make it. Nothing else is normalized.
	 */
	readonly source: string;
	/** How `source` reads. Never the baseline's reading. */
	readonly reading: TReading;
	/** `source` differs from the baseline's source. */
	readonly isDirty: boolean;
	/**
	 * The latest observation that differs from the baseline, while the editor
	 * cannot adopt it: the draft is dirty, the file is missing, or it could
	 * not be read. Cleared when the file matches the baseline again.
	 */
	readonly incoming: Observation<TSnapshot> | undefined;
	/**
	 * The admitted save from submission until its reply. `seenOnDisk` is true
	 * once a read during the save found the submitted text.
	 */
	readonly saving: (SaveAttempt & { readonly seenOnDisk: boolean }) | undefined;
	/** How the latest settled save ended. History: it says nothing about the file now. */
	readonly lastSave: SaveOutcome<TSnapshot> | undefined;
	readonly isDisposed: boolean;
};

/** The document a handle edits. Reads and saves go through it; it never throws on purpose. */
export type EditDocument<TSnapshot extends TextCapture, TReading> = {
	readonly path: string;
	interpret(source: string): TReading;
	read(): Promise<Observation<TSnapshot>>;
	/** Save complete text conditional on `baseline`. The receipt describes the submitted bytes. */
	save(
		baseline: TSnapshot,
		source: string,
	): Promise<Result<TSnapshot, TableReplaceError>>;
	/** Hear that this document may have changed. Returns the function that stops listening. */
	watch(onChange: () => void): () => void;
};

/**
 * Open a handle on `displayed`: the snapshot the caller already shows. It
 * subscribes to change hints first, then reads once, so a change between the
 * caller's read and this call is not missed.
 *
 * The handle is bound to `document.path` for its life. A snapshot of another
 * file is a programming error here, and a refusal in a resolution.
 */
export function createEditHandle<TSnapshot extends TextCapture, TReading>(
	document: EditDocument<TSnapshot, TReading>,
	displayed: TSnapshot,
) {
	type State = EditState<TSnapshot, TReading>;
	const path = document.path;
	if (displayed.path !== path)
		throw new TypeError(
			`A handle on '${path}' cannot start from a snapshot of '${displayed.path}'`,
		);

	let state: State = Object.freeze({
		path,
		baseline: Object.freeze({ ...displayed }),
		source: displayed.text,
		reading: document.interpret(displayed.text),
		isDirty: false,
		incoming: undefined,
		saving: undefined,
		lastSave: undefined,
		isDisposed: false,
	});
	const listeners = new Set<(state: State) => void>();
	let delivering = false;

	/**
	 * Replace the state and deliver it. Delivery is not reentrant: a listener
	 * that changes the state mid-delivery is not called back inside itself;
	 * the running loop delivers the newer state to everyone afterward. Each
	 * listener therefore receives states in order and the current state last.
	 */
	function update(patch: Partial<State>) {
		state = Object.freeze({ ...state, ...patch });
		if (delivering) return;
		delivering = true;
		try {
			let sent: State | undefined;
			while (sent !== state) {
				sent = state;
				for (const listener of [...listeners]) {
					if (!listeners.has(listener)) continue;
					try {
						listener(sent);
					} catch (error) {
						queueMicrotask(() => {
							throw error;
						});
					}
				}
			}
		} finally {
			delivering = false;
		}
	}

	/**
	 * Bumped when a save settles or a resolution moves the baseline. A read
	 * that started under an older epoch may describe the file before that
	 * point, so its completion is dropped and the read runs again.
	 */
	let epoch = 0;
	let rereadRequested = false;
	let readLoop: Promise<void> | undefined;

	/** Read now. Reads run one at a time; the promise settles after a read that started after this call. */
	function refresh(): Promise<void> {
		if (state.isDisposed) return Promise.resolve();
		rereadRequested = true;
		readLoop ??= runReads();
		return readLoop;
	}

	async function runReads() {
		try {
			while (rereadRequested && !state.isDisposed) {
				rereadRequested = false;
				const startedIn = epoch;
				const observation = await readDocument();
				if (state.isDisposed) return;
				if (startedIn === epoch) observe(observation);
				else rereadRequested = true;
			}
		} finally {
			readLoop = undefined;
		}
	}

	async function readDocument(): Promise<Observation<TSnapshot>> {
		try {
			return await document.read();
		} catch (cause) {
			return {
				kind: 'unreadable',
				error: FileError.Io({ path, operation: 'read', cause }).error,
			};
		}
	}

	/** Apply one observation that is the latest knowledge of the file. */
	function observe(observation: Observation<TSnapshot>) {
		const { saving, baseline, isDirty } = state;
		if (saving !== undefined) {
			// Until the reply arrives, the only fact worth keeping is that the
			// submitted text is already on disk. Everything else is reread after
			// the save settles, against the baseline the reply establishes.
			if (
				!saving.seenOnDisk &&
				observation.kind === 'present' &&
				observation.snapshot.text === saving.source
			)
				update({ saving: { ...saving, seenOnDisk: true } });
			return;
		}
		if (observation.kind !== 'present') {
			if (
				state.incoming?.kind !== observation.kind ||
				observation.kind === 'unreadable'
			)
				update({ incoming: observation });
			return;
		}
		const { snapshot } = observation;
		if (snapshot.sha256 === baseline.sha256) {
			if (state.incoming !== undefined) update({ incoming: undefined });
			return;
		}
		if (!isDirty) {
			// Idle: follow the saved file.
			update({
				baseline: snapshot,
				source: snapshot.text,
				reading: document.interpret(snapshot.text),
				incoming: undefined,
			});
			return;
		}
		if (snapshot.text === state.source) {
			// Someone saved exactly this draft: it is no longer unsaved.
			update({ baseline: snapshot, isDirty: false, incoming: undefined });
			return;
		}
		if (
			state.incoming?.kind === 'present' &&
			state.incoming.snapshot.sha256 === snapshot.sha256
		)
			return;
		update({ incoming: observation });
	}

	function refusal(reason: EditRefusal['reason']) {
		return Err({ kind: 'refused', reason } as const);
	}

	/**
	 * Replace the candidate source. Text that does not parse is a valid
	 * candidate. A lone surrogate becomes U+FFFD here, as encoding would make
	 * it, so the draft is the text a save actually writes.
	 */
	function input(text: string): Result<undefined, EditRefusal> {
		if (state.isDisposed) return refusal('disposed');
		const source = text.toWellFormed();
		if (source === state.source) return Ok(undefined);
		update({
			source,
			reading: document.interpret(source),
			isDirty: source !== state.baseline.text,
		});
		return Ok(undefined);
	}

	/**
	 * The admitted save, from admission until its outcome is known. It is set
	 * before any listener hears `saving` and released before any listener
	 * hears the outcome, so a listener that disposes, or starts the next save,
	 * finds the right one.
	 */
	let admitted:
		| { readonly completion: Promise<SaveOutcome<TSnapshot>> }
		| undefined;

	/**
	 * Submit the candidate once, conditional on the displayed baseline. Input
	 * that arrives during the save stays in the draft and stays unsaved
	 * against the receipt. A conflict is reported, never retried.
	 */
	function save(): Promise<SaveOutcome<TSnapshot> | SaveRefusal> {
		const refused = (reason: SaveRefusal['reason']) =>
			Promise.resolve({ kind: 'refused', reason } as const);
		if (state.isDisposed) return refused('disposed');
		if (state.saving !== undefined) return refused('saving');
		if (!state.isDirty) return refused('clean');
		const baseline = state.baseline;
		const attempt: SaveAttempt = Object.freeze({
			source: state.source,
			against: Object.freeze({ path, sha256: baseline.sha256 }),
		});
		const completion = Promise.withResolvers<SaveOutcome<TSnapshot>>();
		const current = { completion: completion.promise };
		admitted = current;
		update({ saving: { ...attempt, seenOnDisk: false } });
		submit(baseline, attempt, current).then(
			completion.resolve,
			completion.reject,
		);
		return completion.promise;
	}

	async function submit(
		baseline: TSnapshot,
		attempt: SaveAttempt,
		current: NonNullable<typeof admitted>,
	): Promise<SaveOutcome<TSnapshot>> {
		let result: Result<TSnapshot, TableReplaceError>;
		try {
			result = await document.save(baseline, attempt.source);
		} catch (cause) {
			// A transport that threw may have delivered the request.
			result = FileError.Unconfirmed({ path, operation: 'replace', cause });
		}
		epoch += 1;
		if (admitted === current) admitted = undefined;
		const outcome = settle(attempt, result);
		// Every settlement is followed by one observation against the new
		// baseline: a hint that arrived during the save, a conflict's incoming
		// text, or whatever an unconfirmed save left.
		void refresh();
		return outcome;
	}

	function settle(
		attempt: SaveAttempt,
		result: Result<TSnapshot, TableReplaceError>,
	): SaveOutcome<TSnapshot> {
		if (result.error === null) {
			const receipt = result.data;
			const outcome = { kind: 'saved', receipt } as const;
			update({
				baseline: receipt,
				isDirty: state.source !== receipt.text,
				incoming: undefined,
				saving: undefined,
				lastSave: outcome,
			});
			return outcome;
		}
		const error = result.error;
		const outcome: SaveOutcome<TSnapshot> =
			error.name === 'Conflict'
				? { kind: 'conflict', attempt, error }
				: error.name === 'Unconfirmed'
					? { kind: 'unconfirmed', attempt, error }
					: { kind: 'failed', attempt, error };
		update({ saving: undefined, lastSave: outcome });
		return outcome;
	}

	/**
	 * Resolve against a snapshot the person reviewed. A newer observation that
	 * arrived since stays `incoming`, so the next save can conflict again.
	 */
	function resolve(
		reviewed: TSnapshot,
		source: string,
	): Result<undefined, EditRefusal> {
		if (state.isDisposed) return refusal('disposed');
		if (state.saving !== undefined) return refusal('saving');
		if (reviewed.path !== path) return refusal('otherPath');
		const baseline = Object.freeze({ ...reviewed });
		epoch += 1;
		const incoming = state.incoming;
		update({
			baseline,
			source,
			reading:
				source === state.source ? state.reading : document.interpret(source),
			isDirty: source !== baseline.text,
			incoming:
				incoming?.kind === 'present' &&
				incoming.snapshot.sha256 === baseline.sha256
					? undefined
					: incoming,
		});
		void refresh();
		return Ok(undefined);
	}

	const stopWatching = document.watch(() => void refresh());
	void refresh();

	return {
		/** The current state. The same object until the next change. */
		get: () => state,
		/**
		 * Call `listener` now with the current state, then with each change.
		 * Solid's `from` and the Svelte panel's `createSubscriber` consume this.
		 */
		subscribe(listener: (state: State) => void): () => void {
			listeners.add(listener);
			listener(state);
			return () => {
				listeners.delete(listener);
			};
		},
		input,
		save,
		refresh,
		/**
		 * Drop the draft: the candidate becomes the baseline's text, then the
		 * file is read. Refused while a save is admitted: a discard cannot
		 * cancel that write, and reverting the draft under it would make the
		 * next save an undo of it. After an unconfirmed save it is allowed: if
		 * that text lands later, a clean draft adopts it like any change.
		 */
		discard(): Result<undefined, EditRefusal> {
			if (state.isDisposed) return refusal('disposed');
			if (state.saving !== undefined) return refusal('saving');
			const { baseline } = state;
			update({
				source: baseline.text,
				reading: document.interpret(baseline.text),
				isDirty: false,
			});
			void refresh();
			return Ok(undefined);
		},
		/** Keep the draft, now conditional on the reviewed snapshot. Saving is a separate call. */
		keepDraft: (reviewed: TSnapshot) => resolve(reviewed, state.source),
		/** Replace the draft with the reviewed snapshot's text. */
		takeObserved: (reviewed: TSnapshot) => resolve(reviewed, reviewed.text),
		/**
		 * Stop observing and admit no new input, read, or save. A save already
		 * admitted keeps running; its outcome still lands in the state, and the
		 * returned promise settles with it.
		 */
		dispose(): Promise<SaveOutcome<TSnapshot> | undefined> {
			if (!state.isDisposed) {
				stopWatching();
				update({ isDisposed: true });
			}
			return admitted?.completion ?? Promise.resolve(undefined);
		},
	};
}

export type EditHandle<TSnapshot extends TextCapture, TReading> = ReturnType<
	typeof createEditHandle<TSnapshot, TReading>
>;
