/**
 * Opens the workspace this page was given.
 *
 * Where the page runs decides which storage it has: inside a desktop app the
 * folder is the shell's, and in a browser tab it is this browser's own. That
 * is asked of the runtime, not inferred from the host's token. The desktop
 * workspace also needs the Whispering host, whose token the standalone shell
 * injects before the page runs. A desktop app that injected none is not
 * Whispering's shell, and the page says so and opens nothing.
 *
 * The desktop workspace and its Tauri adapter are loaded only when the page is
 * inside a desktop app, so a browser tab never loads them.
 */
import { isTauri } from '@tauri-apps/api/core';
import type { Result } from 'wellcrafted/result';
import { type Workspace, WorkspaceError } from './types.js';

export type {
	CloseDecision,
	InjectionState,
	WhisperingFolder,
	Workspace,
	WorkspaceError,
} from './types.js';

declare global {
	interface Window {
		/** Set by the Whispering desktop shell before the page runs. */
		__WHISPERING_BRIDGE__?: { readonly token: string };
	}
}

/**
 * Called from a mounted component; importing this module opens nothing. A
 * refusal is returned as it is. Inside a desktop app browser storage is never
 * opened, whatever is missing or refused.
 */
export async function openWorkspace(): Promise<
	Result<Workspace, WorkspaceError>
> {
	if (!isTauri()) {
		const { openBrowserWorkspace } = await import('./browser.js');
		return openBrowserWorkspace();
	}
	const bridge = window.__WHISPERING_BRIDGE__;
	if (bridge === undefined) return WorkspaceError.HostMissing();
	const { openDesktopWorkspace } = await import('./desktop.js');
	return openDesktopWorkspace({ origin: location.origin, token: bridge.token });
}

/**
 * After opening has failed and nothing is open: let the person close the
 * window. Whispering's shell holds every close until the page answers, and a
 * page with no session has nothing else that would answer. Returns the
 * function that stops answering, which must be called before anything is
 * opened again.
 *
 * Only for a failed opening. Never call this while an opening is under way or
 * a session exists: it answers `proceed` without looking at anything, which
 * is right only when there is nothing to look at.
 *
 * In a browser tab the browser owns leaving, and a desktop app that injected
 * no host token is not Whispering's shell and asks no such question, so in
 * both this does nothing.
 */
export function answerCloseAfterFailedOpening(): () => void {
	if (!isTauri()) return () => {};
	const bridge = window.__WHISPERING_BRIDGE__;
	if (bridge === undefined) return () => {};
	const connection = { origin: location.origin, token: bridge.token };
	let stopped = false;
	let stop: (() => void) | undefined;
	void import('./desktop.js').then(
		({ answerCloseWithNothingOpen }) => {
			if (!stopped) stop = answerCloseWithNothingOpen(connection);
		},
		// The desktop module could not load, so nothing can answer. The window
		// stays open, which loses nothing.
		() => {},
	);
	return () => {
		stopped = true;
		stop?.();
	};
}
