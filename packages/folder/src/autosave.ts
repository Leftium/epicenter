/**
 * Snapshot saves for one editing session (ADR-0515).
 *
 * The caller owns its editable value. `request(value)` prepares an immutable
 * snapshot of it before returning, so a later edit cannot change what an
 * earlier request saves. One write runs at a time; requests made while it
 * runs replace one pending snapshot, so intermediate snapshots may never be
 * written. A save result never assigns the caller's value.
 *
 * Each write is guarded by the capture the previous one confirmed, starting
 * from the session's own: a change made elsewhere is `Conflict`, never
 * overwritten. `onState` reports the latest request's outcome: `saving`
 * while its work runs or waits, `saved` with the capture of the bytes now
 * in the file, or the `error` that stopped it. A request that cannot be prepared is that error at once: it drops the
 * pending snapshot, and an older write that finishes afterward cannot report
 * `saved` over it. Nothing retries; requesting again is the retry. Nothing
 * is saved when the session ends unless it was requested.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { createLogger } from 'wellcrafted/logger';
import type { Result } from 'wellcrafted/result';
import type { FileCapture } from './capture.js';
import { callObserver } from './observer.js';

const log = createLogger('folder/autosave');

export const AutosaveError = defineErrors({
	/** The writer threw instead of returning a result: a defect, not a save failure. */
	UnexpectedWriterError: ({ cause }: { cause: unknown }) => ({
		message: 'The autosave writer threw instead of returning a save result.',
		cause,
	}),
});
export type AutosaveError = InferErrors<typeof AutosaveError>;

/**
 * The outcome of an editing session's latest requested save. Every state
 * names `file`, the bytes the session last confirmed: they guard its next
 * write and any other guarded action on the file, such as a rename, even
 * while a newer request is saving or has failed.
 */
export type SaveState<TError> =
	| { readonly status: 'saved'; readonly file: FileCapture }
	| { readonly status: 'saving'; readonly file: FileCapture }
	| {
			readonly status: 'error';
			readonly error: TError;
			readonly file: FileCapture;
	  };

/** A save state before the session's confirmed capture is attached. */
type Outcome<TError> =
	| { status: 'saved' }
	| { status: 'saving' }
	| { status: 'error'; error: TError };

/** One editing session's saves: request a snapshot, or wait for the work in flight. */
export type Autosave<TValue, TError> = {
	/**
	 * Prepare a snapshot of `value` now and save it after the running write.
	 * Returns nothing: a coalesced request has no receipt of its own.
	 */
	request(value: TValue): void;
	/**
	 * Wait for the running and pending work, and return the latest state.
	 * Starts nothing and retries nothing. Stop requesting first when a
	 * command needs a stable boundary.
	 */
	settled(): Promise<SaveState<TError>>;
};

/**
 * Coordinate snapshot saves over `file`. `prepare` runs synchronously inside
 * `request`; `write` saves one prepared snapshot over the confirmed capture
 * and returns the capture of what it saved. Construction reads, writes, and
 * reports nothing.
 */
export function createAutosave<TValue, TSnapshot, TError>({
	file,
	prepare,
	write,
	onState,
}: {
	file: FileCapture;
	prepare(value: TValue): Result<TSnapshot, TError>;
	write(
		snapshot: TSnapshot,
		over: FileCapture,
	): Promise<Result<FileCapture, TError>>;
	onState(state: SaveState<TError | AutosaveError>): void;
}): Autosave<TValue, TError | AutosaveError> {
	type State = SaveState<TError | AutosaveError>;
	/** What the file held after the last confirmed save: the next write's guard. */
	let confirmed = file;
	let state: State = Object.freeze({ status: 'saved', file: confirmed });
	let pending: { snapshot: TSnapshot } | undefined;
	/** The latest request's preparation failure, until a newer request prepares. */
	let refused: { error: TError } | undefined;
	let batch: Promise<State> | undefined;

	function publish(next: Outcome<TError | AutosaveError>) {
		state = Object.freeze({ ...next, file: confirmed });
		callObserver('save state observer', onState, state);
	}

	async function writeFrom(snapshot: TSnapshot, done: (state: State) => void) {
		let outcome: Result<FileCapture, TError | AutosaveError>;
		try {
			// Yield even when the writer throws synchronously, so a terminal
			// observer's next request cannot grow the recursive stack.
			outcome = await Promise.resolve().then(() => write(snapshot, confirmed));
		} catch (cause) {
			const defect = AutosaveError.UnexpectedWriterError({ cause });
			// Keep defects visible even when newer work supersedes them.
			log.error(defect);
			outcome = defect;
		}

		// A generic error type cannot narrow `data`; a null error means it is the capture.
		if (outcome.error === null) confirmed = outcome.data as FileCapture;
		if (pending === undefined)
			publish(
				// The latest request's own failure stands: this older write cannot
				// replace it, though a landed write still advances its `file`.
				refused !== undefined
					? { status: 'error', error: refused.error }
					: outcome.error === null
						? { status: 'saved' }
						: { status: 'error', error: outcome.error },
			);

		// A terminal observer can synchronously request more. Take that
		// snapshot before the next notification can request again.
		if (pending !== undefined) {
			const next = pending.snapshot;
			pending = undefined;
			if (state.status !== 'saving') publish({ status: 'saving' });
			void writeFrom(next, done);
			return;
		}
		batch = undefined;
		done(state);
	}

	return {
		request(value) {
			const { data, error } = prepare(value);
			if (error !== null) {
				// The latest request failed: older pending text is not what was asked for.
				pending = undefined;
				refused = { error };
				publish({ status: 'error', error });
				return;
			}
			// A generic error type cannot narrow `data`; a null error means it is the snapshot.
			const snapshot = data as TSnapshot;
			refused = undefined;
			if (batch !== undefined) {
				pending = { snapshot };
				if (state.status !== 'saving') publish({ status: 'saving' });
				return;
			}
			const completion = Promise.withResolvers<State>();
			batch = completion.promise;
			void writeFrom(snapshot, completion.resolve);
			publish({ status: 'saving' });
		},
		settled() {
			return batch ?? Promise.resolve(state);
		},
	};
}
