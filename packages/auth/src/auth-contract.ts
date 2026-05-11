import type { Result } from 'wellcrafted/result';
import type { AuthError } from './auth-errors.js';
import type { AuthIdentity } from './auth-types.js';

export type AuthState =
	| { status: 'pending' }
	| { status: 'signed-in'; identity: AuthIdentity }
	| { status: 'signed-out' };

export type AuthClient = {
	state: AuthState;
	bearerToken: string | null;
	onStateChange(fn: (state: AuthState) => void): () => void;
	signIn(input: {
		email: string;
		password: string;
	}): Promise<Result<undefined, AuthError>>;
	signUp(input: {
		email: string;
		password: string;
		name: string;
	}): Promise<Result<undefined, AuthError>>;
	signInWithSocial(input: {
		provider: SocialProvider;
	}): Promise<Result<undefined, AuthError>>;
	signOut(): Promise<Result<undefined, AuthError>>;
	fetch(input: Request | string | URL, init?: RequestInit): Promise<Response>;
	[Symbol.dispose](): void;
};

export type SocialProvider = 'google';
