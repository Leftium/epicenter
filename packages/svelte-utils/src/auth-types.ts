import { type } from 'arktype';

export const StoredUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type StoredUser = typeof StoredUser.infer;

export const AuthSession = type({
	status: "'anonymous'",
}).or({
	status: "'authenticated'",
	token: 'string',
	user: StoredUser,
});

export type AuthSession = typeof AuthSession.infer;

export const PersistedSession = AuthSession;
export type PersistedSession = AuthSession;

export type AuthActivity =
	| { status: 'idle' }
	| { status: 'bootstrapping' }
	| { status: 'refreshing' }
	| { status: 'signing-in' }
	| { status: 'signing-out' };

export type AuthSessionStorage = {
	readonly current: AuthSession;
	set(value: AuthSession): void | Promise<void>;
	watch(callback: (value: AuthSession) => void): (() => void) | undefined;
	whenReady?: Promise<void>;
};
