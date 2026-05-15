import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { LocalUnlockBundle } from './auth-types.js';

/**
 * Three variants. `unlock` is always present in `signed-in` and
 * `reauth-required` because we persist it. Auth state carries capability
 * material only; profile data is fetched by application surfaces that display
 * it.
 */
export type AuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			unlock: LocalUnlockBundle;
	  }
	| {
			status: 'reauth-required';
			unlock: LocalUnlockBundle;
	  };

export type AuthClient = {
	state: AuthState;
	onStateChange(fn: (state: AuthState) => void): () => void;
	startSignIn(): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	openWebSocket(url: string | URL, protocols?: string[]): Promise<WebSocket>;
	[Symbol.dispose](): void;
};
