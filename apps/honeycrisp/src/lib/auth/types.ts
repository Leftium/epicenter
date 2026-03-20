/**
 * Auth types shared across the auth module.
 *
 * Platform-agnostic—no chrome.storage, no localStorage, no Svelte runes.
 * Each app provides a concrete {@link AuthStorageAdapter} implementation
 * that bridges to the platform's persistence mechanism.
 */

import { type } from 'arktype';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';

// ─── User Schema ─────────────────────────────────────────────────────────────

/**
 * Schema for the authenticated user object returned by Better Auth.
 *
 * Validates data read from storage—invalid shapes fall back to `undefined`
 * rather than crashing the app.
 */
export const AuthUser = type({
	id: 'string',
	createdAt: 'string',
	updatedAt: 'string',
	email: 'string',
	emailVerified: 'boolean',
	name: 'string',
	'image?': 'string | null | undefined',
});

export type AuthUser = typeof AuthUser.infer;

// ─── Phase Machine ───────────────────────────────────────────────────────────

/**
 * Discriminated union for auth lifecycle phases.
 *
 * The `signed-out` variant carries an optional error message from the
 * last failed sign-in attempt—cleared on the next attempt.
 */
export type AuthPhase =
	| { status: 'checking' }
	| { status: 'signing-in' }
	| { status: 'signing-out' }
	| { status: 'signed-in' }
	| { status: 'signed-out'; error?: string };

// ─── Errors ──────────────────────────────────────────────────────────────────

export const AuthError = defineErrors({
	SignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	SignUpFailed: ({ cause }: { cause: unknown }) => ({
		message: `Sign-up failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
	GoogleSignInFailed: ({ cause }: { cause: unknown }) => ({
		message: `Google sign-in failed: ${extractErrorMessage(cause)}`,
		cause,
	}),
});
export type AuthError = InferErrors<typeof AuthError>;

// ─── Storage Adapter ─────────────────────────────────────────────────────────

/**
 * Platform-agnostic storage adapter for auth tokens and user data.
 *
 * Web apps implement this with `createPersistedState` (localStorage).
 * Chrome extensions implement this with `createStorageState` (chrome.storage).
 *
 * The adapter provides synchronous reads (`.get()`) and async writes (`.set()`).
 * `whenReady` resolves once the initial value has been loaded from the
 * underlying storage—await it before trusting `.get()` in async code paths.
 *
 * The optional `watch` callback fires when the value changes from an
 * external source (e.g. another browser tab or extension context).
 */
export type AuthStorageAdapter<T> = {
	/** Read the current value synchronously. */
	get(): T;
	/** Write a new value. Updates the synchronous read immediately, persists async. */
	set(value: T): Promise<void>;
	/** Resolves once the initial value has been loaded from storage. */
	whenReady: Promise<void>;
	/**
	 * Watch for external changes (other tabs, other extension contexts).
	 * Returns an unsubscribe function.
	 */
	watch?(callback: (value: T) => void): () => void;
};

// ─── Factory Config ──────────────────────────────────────────────────────────

/**
 * Configuration for {@link createAuthState}.
 *
 * Platform-specific behavior is injected via `storage`, `signInWithGoogle`,
 * and workspace lifecycle callbacks. The factory owns the phase machine,
 * Better Auth client, and session validation—none of that is platform-specific.
 */
export type AuthStateConfig = {
	/** Base URL for the Better Auth API (e.g. `https://api.epicenter.so`). */
	baseURL: string;
	/** Storage adapter for the auth token. */
	tokenStorage: AuthStorageAdapter<string | undefined>;
	/** Storage adapter for the cached user object. */
	userStorage: AuthStorageAdapter<AuthUser | undefined>;
	/**
	 * Optional override for Google sign-in. Web apps leave this undefined
	 * to use Better Auth's built-in redirect flow. Chrome extensions pass
	 * a function that uses `chrome.identity.launchWebAuthFlow`.
	 */
	signInWithGoogle?: () => Promise<AuthUser>;
	/**
	 * Called after successful sign-in with the encryption key from the session.
	 * Use this to activate workspace encryption and reconnect sync.
	 */
	onSignedIn?: (encryptionKey?: string) => Promise<void>;
	/**
	 * Called after sign-out. Use this to deactivate workspace encryption
	 * and reconnect sync without a token.
	 */
	onSignedOut?: () => Promise<void>;
};
