import { encryptionKeysEqual } from '@epicenter/encryption';
import type { AuthState } from './auth-contract.js';
import type { AuthIdentity, AuthUser } from './auth-types.js';

export function createAuthStateStore(initialState: AuthState) {
	let state = initialState;
	const stateChangeListeners = new Set<(state: AuthState) => void>();

	return {
		get state() {
			return state;
		},
		setState(next: AuthState) {
			if (authStatesEqual(state, next)) return;
			state = next;
			for (const listener of stateChangeListeners) {
				try {
					listener(next);
				} catch (error) {
					console.error('[auth] subscriber threw:', error);
				}
			}
		},
		onStateChange(fn: (state: AuthState) => void) {
			stateChangeListeners.add(fn);
			return () => {
				stateChangeListeners.delete(fn);
			};
		},
		clearListeners() {
			stateChangeListeners.clear();
		},
	};
}

export function authStateFromIdentity(
	identity: AuthIdentity | null,
): AuthState {
	return identity === null
		? { status: 'signed-out' }
		: { status: 'signed-in', identity };
}

export function identitiesEqual(
	left: AuthIdentity | null,
	right: AuthIdentity | null,
) {
	if (left === null || right === null) return left === right;
	return (
		usersEqual(left.user, right.user) &&
		encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
	);
}

function authStatesEqual(left: AuthState, right: AuthState) {
	if (left.status !== right.status) return false;
	if (
		(left.status !== 'signed-in' && left.status !== 'reauth-required') ||
		(right.status !== 'signed-in' && right.status !== 'reauth-required')
	) {
		return true;
	}
	return identitiesEqual(left.identity, right.identity);
}

function usersEqual(left: AuthUser, right: AuthUser) {
	return (
		left.id === right.id &&
		left.createdAt === right.createdAt &&
		left.updatedAt === right.updatedAt &&
		left.email === right.email &&
		left.emailVerified === right.emailVerified &&
		left.name === right.name &&
		left.image === right.image
	);
}
