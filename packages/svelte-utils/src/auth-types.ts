import { type } from 'arktype';

/**
 * Durable user snapshot stored inside an authenticated local session.
 *
 * The auth transport normalizes Better Auth's `Date` values to ISO strings so
 * session persistence stays JSON-friendly across browser storage backends.
 */
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

/**
 * Local auth session state used by apps and persisted stores.
 *
 * This stays intentionally small: either the user is anonymous, or the app has
 * a bearer token plus the normalized user snapshot needed for boot and refresh.
 */
export const AuthSession = type({
	status: "'anonymous'",
}).or({
	status: "'authenticated'",
	token: 'string',
	user: StoredUser,
});

export type AuthSession = typeof AuthSession.infer;

/** Lifecycle state for long-running auth operations in UI code. */
export type AuthOperation =
	| { status: 'idle' }
	| { status: 'bootstrapping' }
	| { status: 'refreshing' }
	| { status: 'signing-in' }
	| { status: 'signing-out' };

/**
 * Minimal session persistence adapter used by `createAuthSession()`.
 *
 * Implementations own storage details such as `localStorage`, chrome storage,
 * or any reactive wrapper. The auth layer only depends on the current value,
 * a setter, and an optional readiness gate.
 */
export type AuthSessionStorage = {
	readonly current: AuthSession;
	set(value: AuthSession): void | Promise<void>;
	whenReady?: Promise<void>;
};

/** Extract a numeric HTTP status code from an untyped error object. */
export function readStatusCode(error: unknown): number | undefined {
	if (typeof error !== 'object' || error === null) return undefined;
	if (!('status' in error)) return undefined;
	return typeof error.status === 'number' ? error.status : undefined;
}
