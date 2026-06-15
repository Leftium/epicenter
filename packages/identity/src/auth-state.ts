import type { OwnerId } from './identity.js';

/**
 * Current auth state for local-first workspace clients.
 *
 * `ownerId` is present in `signed-in` and `reauth-required` because it belongs
 * to local workspace operations: even when an OAuth grant needs reauth, the
 * cached owner id still picks the right local storage partition.
 *
 * This is capability state, not credential state. It lives in the MIT toolkit
 * so the MIT workspace and the AGPL auth client can share one definition
 * without workspace importing auth across the license firewall.
 */
export type AuthState =
	| { status: 'signed-out' }
	| { status: 'signed-in'; ownerId: OwnerId }
	| { status: 'reauth-required'; ownerId: OwnerId };
