/**
 * Reactive auth-gated payload.
 *
 * Listens to `auth.state` and builds the app payload on sign-in, disposes
 * on sign-out. Same-user `reauth-required` is a no-op so the payload stays
 * mounted across credential refreshes.
 *
 * The framework owns the lifecycle; apps own the payload shape. The build
 * function returns whatever shape the app wants (it must be `Disposable`).
 * Apps typically alias `session.require` to a named export
 * (`export const requireFuji = session.require`) for a one-line presence
 * assertion in descendants.
 *
 * Lazy callbacks (e.g., `encryptionKeys`, `openWebSocket`) are read at:
 *   - attachment time (e.g., `attachEncryption` reads `encryptionKeys()` once
 *     per store registration to derive that store's keyring)
 *   - connection boundaries (`openWebSocket` is invoked at each sync
 *     connection attempt to attach a fresh bearer subprotocol)
 *
 * They are NOT read by already-attached encrypted stores. Same-user key
 * rotation does not propagate to stores whose keyring was derived at an
 * earlier registration; re-attach the store to derive a new keyring.
 *
 * Requires an `AuthClient` whose `state` is Svelte-reactive (use
 * `@epicenter/auth-svelte`, not `@epicenter/auth` directly).
 *
 * @example
 * ```ts
 * export const session = createSession({
 *   auth,
 *   build: (identity) => openFujiBrowser({
 *     userId: identity.user.id,
 *     encryptionKeys: () => requireIdentity(auth).encryptionKeys,
 *     ...
 *   }),
 * });
 *
 * export const requireFuji = session.require;
 * ```
 */

import type { AuthClient, WorkspaceIdentity } from '@epicenter/auth';
import { createSessionLifecycle } from './session-lifecycle.js';

export function createSession<T extends Disposable>({
	auth,
	build,
}: {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => T;
}) {
	let payload = $state<T | null>(null);
	const lifecycle = createSessionLifecycle<T>({
		auth,
		build,
		getPayload: () => payload,
		setPayload: (next) => {
			payload = next;
		},
	});

	function require(): T {
		if (!payload) {
			throw new Error(
				'[session] require() called without a payload. ' +
					'A descendant likely mounted outside the signed-in gate.',
			);
		}
		return payload;
	}

	return {
		get current(): T | null {
			return payload;
		},
		require,
		[Symbol.dispose]() {
			lifecycle[Symbol.dispose]();
		},
	};
}
