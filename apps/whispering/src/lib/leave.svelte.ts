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
 * If Whispering's host has stopped, the shell cannot ask through it. The shell
 * then tells the page directly that a close was attempted, and the
 * confirmation appears with that explained. The window stays open until the
 * person chooses to quit: with no host to relay an answer, quitting is always
 * their explicit choice, even when nothing is held.
 *
 * A stopped host does not stop saving. The folder belongs to the shell and
 * stays open, so a draft still saves and a pending recording can still be
 * tried again; what is held is read live, and the prompt follows it. What the
 * host did is what is gone: the terminal and new transcription and
 * transformation requests. A save can still fail for its own reasons, as it
 * can at any time.
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
	/** The host is gone and cannot relay answers. The folder is still open. */
	let hostGone = $state(false);
	let preparing = false;
	let quitting = false;
	/** The session is being closed. A guard that stopped listening approves nothing. */
	let disposed = false;

	async function requested() {
		if (closing === undefined || disposed) return;
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
		// Disposed while finding out: the session is closing and saving on its
		// own, and this guard no longer speaks for it.
		if (disposed) return;
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
		/** Whether the prompt is up because the host stopped. */
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
			disposed = true;
			for (const stop of stops) stop?.();
		},
	};
}
