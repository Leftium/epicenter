import { encryptionKeysEqual } from '@epicenter/encryption';
import type { AuthState } from './auth-contract.js';
import type { LocalUnlockBundle } from './auth-types.js';

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

function authStatesEqual(left: AuthState, right: AuthState): boolean {
	if (left.status !== right.status) return false;
	if (left.status === 'signed-out' || right.status === 'signed-out') {
		return left.status === right.status;
	}
	return (
		unlocksEqual(left.unlock, right.unlock) && left.email === right.email
	);
}

export function unlocksEqual(
	left: LocalUnlockBundle,
	right: LocalUnlockBundle,
): boolean {
	return (
		left.userId === right.userId &&
		encryptionKeysEqual(left.encryptionKeys, right.encryptionKeys)
	);
}
