import { requireSignedIn } from '@epicenter/auth-svelte';
import { createSession, type SignedInBase } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { auth } from './auth';
import {
	openHoneycrisp,
	type Honeycrisp,
} from '../routes/(signed-in)/honeycrisp/browser';

export type HoneycrispSignedIn = SignedInBase & {
	readonly honeycrisp: Honeycrisp;
};

export const session = createSession<HoneycrispSignedIn>({
	auth,
	build: (identity) => {
		const userId = identity.user.id;
		const honeycrisp = openHoneycrisp({
			userId,
			peer: {
				id: getOrCreateInstallationId(localStorage),
				name: 'Honeycrisp',
				platform: 'web',
			},
			bearerToken: () => auth.bearerToken,
			encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
		});
		return {
			userId,
			honeycrisp,
			[Symbol.dispose]() {
				honeycrisp[Symbol.dispose]();
			},
		};
	},
});

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

const [getRawSession, setSignedInSession] =
	createContext<HoneycrispSignedIn>();

export { setSignedInSession };

export function getSignedInSession(): HoneycrispSignedIn {
	const s = getRawSession();
	if (!s) {
		throw new Error(
			'[honeycrisp] getSignedInSession() called outside <SignedInSessionProvider>. ' +
				'This route must mount under the signed-in branch of the root layout.',
		);
	}
	return s;
}
