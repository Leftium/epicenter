import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { LocalUnlockBundle } from './auth-types.js';

/**
 * Three variants. `unlock` is always present in `signed-in` and
 * `reauth-required` because we persist it. `email` is `null` until `/api/me`
 * succeeds at least once for the current cell; UIs gate decryption on
 * `unlock`, display labels on `email`. There is no separate freshness flag:
 * an `email` value implies it was confirmed by `/api/me` for the current
 * persisted cell; mutating the cell (sign-out, same-user-guard wipe) clears
 * it back to `null`.
 */
export type AuthState =
	| { status: 'signed-out' }
	| {
			status: 'signed-in';
			unlock: LocalUnlockBundle;
			email: string | null;
	  }
	| {
			status: 'reauth-required';
			unlock: LocalUnlockBundle;
			email: string | null;
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
