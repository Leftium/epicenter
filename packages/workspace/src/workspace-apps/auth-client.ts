import type { AuthState } from '@epicenter/identity';

/**
 * Workspace's structural view of an auth client. Any object whose shape
 * matches (notably `@epicenter/auth`'s `AuthClient`) can be passed to
 * `openProject`.
 *
 * Workspace reads three surfaces: the discriminated `state` (to gate startup
 * on signed-in and to derive the lazy keyring reader), `openWebSocket` (for
 * collaboration sockets with the bearer subprotocol attached), and
 * `onStateChange` (for the reconnect signal). The narrow contract is what
 * lets this package compile without depending on `@epicenter/auth`.
 */
export type WorkspaceAuthClient = {
	state: AuthState;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	onStateChange(fn: (state: AuthState) => void): () => void;
};
