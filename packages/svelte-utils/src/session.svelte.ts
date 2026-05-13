/**
 * Reactive auth-gated payload.
 *
 * Listens to `auth.state` and builds the app payload on sign-in, disposes
 * on sign-out, and refuses a same-session user switch via the
 * `onDifferentUser` callback. Same-user `reauth-required` is a no-op so
 * the payload stays mounted across credential refreshes.
 *
 * The framework owns the lifecycle; apps own the payload shape. There is
 * no envelope, no required field set, no framework-side assertion helper.
 * The build function returns whatever shape the app wants (it must be
 * `Disposable`); each app writes its own `requireX` helper if it wants
 * one.
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
 *   build: (identity) => openFuji({
 *     userId: identity.user.id,
 *     encryptionKeys: () => requireIdentity(auth).encryptionKeys,
 *     ...
 *   }),
 *   onDifferentUser: () => location.reload(),
 * });
 *
 * export function requireFuji() {
 *   if (!session.current) {
 *     throw new Error('requireFuji() called without an authenticated session.');
 *   }
 *   return session.current;
 * }
 * ```
 */

import type { AuthClient, WorkspaceIdentity } from '@epicenter/auth';
import { createSessionLifecycle } from './session-lifecycle.js';

export function createSession<T extends Disposable>({
	auth,
	build,
	onDifferentUser,
}: {
	auth: AuthClient;
	build: (identity: WorkspaceIdentity) => T;
	onDifferentUser?: () => void;
}) {
	let payload = $state<T | null>(null);
	const lifecycle = createSessionLifecycle<T>({
		auth,
		build,
		getPayload: () => payload,
		setPayload: (next) => {
			payload = next;
		},
		onDifferentUser:
			onDifferentUser ??
			(() => {
				/* no-op: app didn't opt in to user-switch handling */
			}),
	});

	return {
		get current(): T | null {
			return payload;
		},
		[Symbol.dispose]() {
			lifecycle[Symbol.dispose]();
		},
	};
}
