/**
 * Reading the old Personal store for an export. Recovery only.
 *
 * The recovery screen imports this module when a person asks to export from
 * their account, and at no other time: the running app has no account, no
 * sign-in gate, and no code for the old store. The store is opened, read
 * once, and closed. Nothing is written to it.
 */
import { openPersonal } from '@epicenter/app/open';
import {
	exportLegacyBundle,
	type LegacyBundle,
	legacyCaptureDefinition,
} from '@epicenter/capture/legacy';
import { auth } from '#platform/auth';

/** The signed-in account's stable identity, or `undefined` when signed out. */
export function signedInAccount() {
	const { account } = auth.getState();
	return account === undefined
		? undefined
		: { authorityId: account.authorityId, principalId: account.principalId };
}

/** Start sign-in. A browser leaves this page; it returns to the recovery screen. */
export async function startSignIn(): Promise<string | undefined> {
	const { error } = await auth.startSignIn();
	return error === null ? undefined : error.message;
}

/**
 * Export what this device holds of the signed-in account's old captures.
 * Rejects when no account is signed in or the store cannot be opened.
 */
export async function exportFromAccount(): Promise<LegacyBundle> {
	const { account } = auth.getState();
	if (account === undefined) throw new Error('Sign in first.');
	const store = await openPersonal(legacyCaptureDefinition, { account });
	try {
		return exportLegacyBundle(store, {
			exportedAt: new Date().toISOString(),
			account: {
				authorityId: account.authorityId,
				principalId: account.principalId,
			},
		});
	} finally {
		await store.close();
	}
}
