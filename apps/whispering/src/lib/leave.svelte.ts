/**
 * Answers the desktop shell when it asks to close the window or quit.
 *
 * Unsaved typing, captured audio that has not reached the folder, a received
 * transcript whose file was not written, and a live recording exist only in
 * this page. The shell cannot see them, so it asks before closing and closes
 * only on this page's `proceed`:
 *
 * - every request is acknowledged with `asking` before anything else, so the
 *   shell knows the page is alive and deciding;
 * - nothing is held (after saving what can be saved): `proceed`, with no prompt;
 * - something is held, or it could not be determined: the page shows its own
 *   confirmation. "Keep working" answers `cancel` and everything stays as it
 *   was. "Discard and quit" answers `proceed`.
 *
 * If the folder host has stopped, the shell cannot ask through it and nothing
 * more can be saved. The shell then tells the page directly that a close was
 * attempted, and the same confirmation appears with that explained. The window
 * stays open until the person chooses to quit.
 *
 * A browser tab has no shell to ask; there the browser's own leave warning
 * applies and this guard does nothing.
 */
import type { Workspace } from './workspace/types.js';

export type LeaveGuard = ReturnType<typeof createLeaveGuard>;

export function createLeaveGuard(
	library: {
		prepareToLeave(): Promise<boolean>;
		readonly unsavedWork: readonly string[];
	},
	closing: Workspace['closing'],
) {
	let asking = $state(false);
	/** The host is gone: nothing more can be saved, and it cannot relay answers. */
	let hostGone = $state(false);
	let preparing = false;
	let quitting = false;

	async function requested() {
		if (closing === undefined) return;
		// First, always: the page is here and has not agreed to anything.
		await closing.answer('asking');
		if (asking || preparing) return;
		preparing = true;
		let safe = false;
		try {
			safe = await library.prepareToLeave();
		} catch {
			// Not knowing what is held is treated as holding something.
		} finally {
			preparing = false;
		}
		if (safe) await closing.answer('proceed');
		else asking = true;
	}

	/** The shell tried to close but has no host to ask through. */
	function requestedWithoutHost() {
		hostGone = true;
		asking = true;
	}

	const stops = [
		closing?.onRequest(() => void requested()),
		closing?.onRequestWithoutHost(requestedWithoutHost),
	];

	return {
		/** Whether the leave confirmation is showing. */
		get asking() {
			return asking;
		},
		/** Whether the prompt is up because the folder host stopped. */
		get hostGone() {
			return hostGone;
		},
		/** What closing now would lose. Read live, so the prompt follows saves. */
		get held() {
			return library.unsavedWork;
		},
		/** Stay open. Nothing in the window changes. */
		async stay() {
			// The prompt also closes itself after "Discard and quit"; that is not a stay.
			if (!asking || quitting) return;
			asking = false;
			if (!hostGone) await closing?.answer('cancel');
		},
		/** Close, dropping whatever is still held only in this window. */
		async discardAndQuit() {
			if (!asking || quitting || closing === undefined) return;
			quitting = true;
			try {
				if (hostGone) closing.quitWithoutHost();
				else await closing.answer('proceed');
			} finally {
				// If the shell did not close, the next close request asks again.
				quitting = false;
				asking = false;
			}
		},
		dispose() {
			for (const stop of stops) stop?.();
		},
	};
}
