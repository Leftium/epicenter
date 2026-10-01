/**
 * Opens the workspace this page was given.
 *
 * The desktop shell injects a bridge token before the page runs; its presence
 * is what makes this the desktop app. Both implementations are plain page
 * code: the desktop one speaks `fetch` to the folder host, and no Node, Bun, or
 * Tauri module exists in either.
 */
import type { Result } from 'wellcrafted/result';
import type { Workspace, WorkspaceError } from './types.js';

export type {
	CloseDecision,
	InjectionState,
	WhisperingFolder,
	Workspace,
	WorkspaceError,
} from './types.js';

declare global {
	interface Window {
		/** Set by the desktop shell, or by a standalone folder host. */
		__WHISPERING_BRIDGE__?: { readonly token: string };
	}
}

/**
 * Called from a mounted component; importing this module opens nothing. The
 * bridge token decides which storage this page has. A refusal from that
 * storage is returned as it is; the other one is never tried instead.
 */
export async function openWorkspace(): Promise<
	Result<Workspace, WorkspaceError>
> {
	const bridge = window.__WHISPERING_BRIDGE__;
	if (bridge !== undefined) {
		const { openDesktopWorkspace } = await import('./desktop.js');
		return openDesktopWorkspace({
			origin: location.origin,
			token: bridge.token,
		});
	}
	const { openBrowserWorkspace } = await import('./browser.js');
	return openBrowserWorkspace();
}
