/**
 * The desktop shell's two messages to the Capture window, and the page's
 * answer.
 *
 *   event  capture-quit-requested   payload: a numeric request ID
 *   invoke capture_quit_answer      { requestId, answer }
 *   event  capture-host-stopped     the Epicenter service that served this
 *                                   page has stopped
 *
 * A quit is answered in two steps. `asking` is sent as soon as the request
 * arrives, so the shell knows this window is deciding. Then exactly one of
 * `proceed` or `cancel` follows, from whoever is listening. A request that
 * arrives before the page has attached its listener waits for it.
 *
 * The stopped service is not the folder. The shell's Rust side owns the
 * directory and keeps saving; a folder that stops is reported by the folder
 * itself, through its Git snapshot.
 *
 * Closing the window is not a quit: the shell hides it and the page stays
 * loaded with its drafts.
 */
import type { QuitAnswer } from './types.js';

export const QUIT_REQUESTED_EVENT = 'capture-quit-requested';
/** The shell's name for it predates the Rust folder owner. */
export const SERVICE_STOPPED_EVENT = 'capture-host-stopped';
export const QUIT_ANSWER_COMMAND = 'capture_quit_answer';

/** The two shell calls this needs; the desktop leaf supplies Tauri's. */
export type ShellPort = {
	listen(
		event: string,
		handler: (payload: unknown) => void,
	): Promise<() => void>;
	invoke(command: string, args: Record<string, unknown>): Promise<unknown>;
};

export type ShellLifetime = ReturnType<typeof createShellLifetime>;

export function createShellLifetime(port: ShellPort) {
	const quitListeners = new Set<(answer: QuitAnswer) => void>();
	const stoppedListeners = new Set<() => void>();
	/** A request no listener has taken yet. */
	let pending: number | undefined;
	let stopped = false;
	let closed = false;
	let problem: string | undefined;
	const stops: (() => void)[] = [];

	function deliver() {
		if (pending === undefined || quitListeners.size === 0) return;
		const requestId = pending;
		pending = undefined;
		let answered = false;
		const answer: QuitAnswer = async (decision) => {
			if (answered) return;
			answered = true;
			await port.invoke(QUIT_ANSWER_COMMAND, { requestId, answer: decision });
		};
		for (const listener of quitListeners) listener(answer);
	}

	// Settled one by one: a listener that attached is kept, and stopped on
	// close, even when the other was refused.
	const ready = Promise.allSettled([
		port.listen(QUIT_REQUESTED_EVENT, (payload) => {
			if (typeof payload !== 'number') return;
			pending = payload;
			// Tell the shell this window is deciding before any draft settles.
			void port
				.invoke(QUIT_ANSWER_COMMAND, {
					requestId: payload,
					answer: 'asking',
				})
				.catch(() => {});
			deliver();
		}),
		port.listen(SERVICE_STOPPED_EVENT, () => {
			stopped = true;
			for (const listener of stoppedListeners) listener();
		}),
	]).then(([quit, service]) => {
		for (const attached of [quit, service]) {
			if (attached.status !== 'fulfilled') continue;
			if (closed) attached.value();
			else stops.push(attached.value);
		}
		if (quit.status === 'rejected')
			problem = `Quitting Epicenter cannot ask this window about unsaved work first: ${quit.reason instanceof Error ? quit.reason.message : String(quit.reason)}`;
	});

	return {
		/** Settles once the shell listeners are attached, or have failed to. */
		ready,
		get quitProtectionProblem() {
			return problem;
		},
		onQuitRequested(listener: (answer: QuitAnswer) => void) {
			quitListeners.add(listener);
			queueMicrotask(deliver);
			return () => quitListeners.delete(listener);
		},
		onServiceStopped(listener: () => void) {
			stoppedListeners.add(listener);
			if (stopped) queueMicrotask(listener);
			return () => stoppedListeners.delete(listener);
		},
		close() {
			closed = true;
			for (const stop of stops.splice(0)) stop();
		},
	};
}
