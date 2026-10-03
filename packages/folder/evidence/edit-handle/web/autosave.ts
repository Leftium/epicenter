/**
 * EXPERIMENT: app-owned autosave for one retained draft. This is policy built
 * on the handle's public `get`, `subscribe`, and `save`; the engine knows
 * nothing about it.
 *
 *     const autosave = createAutosave(shared, { delayMs: 400 });
 *     autosave.start();   // and autosave.stop(), separately from shared.dispose()
 *
 * One timer and one subscription per handle. A dirty draft is saved once it
 * has gone `delayMs` without new input, and only while no save is running,
 * no changed file is incoming, and the handle is not disposed. Input during
 * a save starts nothing; when that save's receipt leaves newer text dirty,
 * a fresh delay starts.
 *
 * A new conflict, failure, or unknown outcome pauses it. Input, rereads, and
 * remounted views never clear the pause; only `resume()` does. Resuming does
 * not submit over an incoming file either: that file must be reviewed with
 * `keepDraft` or `takeObserved` first, and the next save is still
 * conditional on the reviewed baseline. Nothing is retried.
 * `onPauseChange` reports pause and explicit resume to the app's UI; this
 * policy exposes no second store or framework subscription contract.
 */
import type { TextCapture } from '../../../src/capture.js';
import type { EditHandle, EditState } from '../edit-handle.js';

/** The outcome that paused autosave. */
export type AutosavePause = 'conflict' | 'failed' | 'unconfirmed';

export function createAutosave(
	edit: Pick<EditHandle<TextCapture, unknown>, 'get' | 'subscribe' | 'save'>,
	{
		delayMs,
		onPauseChange,
	}: {
		delayMs: number;
		onPauseChange?: (reason: AutosavePause | undefined) => void;
	},
) {
	type State = EditState<TextCapture, unknown>;
	let stopWatching: (() => void) | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The draft text the running timer is waiting on. */
	let timedSource: string | undefined;
	let paused: AutosavePause | undefined;
	/** The last outcome heard, so only a new one can pause. */
	let heard: State['lastSave'];

	function disarm() {
		clearTimeout(timer);
		timer = undefined;
		timedSource = undefined;
	}

	const isDue = (state: State) =>
		paused === undefined &&
		state.isDirty &&
		state.saving === undefined &&
		state.incoming === undefined &&
		!state.isDisposed;

	function hear(state: State) {
		if (state.lastSave !== heard) {
			heard = state.lastSave;
			const kind = heard?.kind;
			if (kind === 'conflict' || kind === 'failed' || kind === 'unconfirmed') {
				paused = kind;
				onPauseChange?.(paused);
			}
		}
		if (!isDue(state)) return disarm();
		// Still waiting on this text: other news does not restart the delay.
		if (timer !== undefined && timedSource === state.source) return;
		disarm();
		timedSource = state.source;
		timer = setTimeout(() => {
			timer = undefined;
			timedSource = undefined;
			if (isDue(edit.get())) void edit.save();
		}, delayMs);
	}

	return {
		start() {
			if (stopWatching !== undefined) return;
			// Outcomes from before starting do not pause it.
			heard = edit.get().lastSave;
			stopWatching = edit.subscribe(hear);
		},
		/** Stop the timer and the subscription. The pause, if any, stays. */
		stop() {
			stopWatching?.();
			stopWatching = undefined;
			disarm();
		},
		/** Clear the pause after review. An incoming file still blocks saving. */
		resume() {
			paused = undefined;
			onPauseChange?.(undefined);
			if (stopWatching !== undefined) hear(edit.get());
		},
	};
}
