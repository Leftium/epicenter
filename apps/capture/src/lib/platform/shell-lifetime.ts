/**
 * The desktop shell's two messages to the Capture window, and the page's
 * answer.
 *
 *   event  capture-quit-requested   payload: a numeric request ID
 *   invoke capture_quit_answer      { requestId, answer }
 *   event  capture-host-stopped     the host process that owns the folder died
 *
 * A quit is answered in two steps. `asking` is sent as soon as the request
 * arrives, so the shell knows this window is deciding. Then exactly one of
 * `proceed` or `cancel` follows, from whoever is listening. A request that
 * arrives before the page has attached its listener waits for it.
 *
 * Closing the window is not a quit: the shell hides it and the page stays
 * loaded with its drafts.
 */
import type { QuitAnswer } from './types.js';

export const QUIT_REQUESTED_EVENT = 'capture-quit-requested';
export const HOST_STOPPED_EVENT = 'capture-host-stopped';
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

export function createShellLifetime(port: ShellPort | undefined) {
	const quitListeners = new Set<(answer: QuitAnswer) => void>();
	const stoppedListeners = new Set<() => void>();
	/** A request no listener has taken yet. */
	let pending: number | undefined;
	let stopped = false;
	let problem: string | undefined =
		port === undefined
			? 'This window is not running inside the Epicenter desktop app, so quitting Epicenter cannot ask it about unsaved work first.'
			: undefined;
	const stops: (() => void)[] = [];

	function deliver() {
		if (pending === undefined || quitListeners.size === 0 || !port) return;
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

	const ready =
		port === undefined
			? Promise.resolve()
			: Promise.all([
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
					port.listen(HOST_STOPPED_EVENT, () => {
						stopped = true;
						for (const listener of stoppedListeners) listener();
					}),
				]).then(
					(unlisten) => {
						stops.push(...unlisten);
					},
					(cause) => {
						problem = `Quitting Epicenter cannot ask this window about unsaved work first: ${cause instanceof Error ? cause.message : String(cause)}`;
					},
				);

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
		onHostStopped(listener: () => void) {
			stoppedListeners.add(listener);
			if (stopped) queueMicrotask(listener);
			return () => stoppedListeners.delete(listener);
		},
		close() {
			for (const stop of stops.splice(0)) stop();
		},
	};
}
