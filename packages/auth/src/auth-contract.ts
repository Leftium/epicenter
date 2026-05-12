import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { WorkspaceIdentity } from './auth-types.js';

export type AuthState =
	| { status: 'signed-in'; identity: WorkspaceIdentity }
	| { status: 'reauth-required'; identity: WorkspaceIdentity }
	| { status: 'signed-out' };

export type AuthClient = {
	state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(input?: {
		returnTo?: string;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
