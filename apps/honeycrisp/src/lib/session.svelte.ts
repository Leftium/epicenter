import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import { createSession, type InferSignedIn } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { auth } from './auth';
import { openHoneycrisp } from '../routes/(signed-in)/honeycrisp/browser';
import { createHoneycrispState } from '../routes/(signed-in)/state';

export const session = createSession({
	auth,
	build: (identity: AuthIdentity) => {
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
		const state = createHoneycrispState(honeycrisp);
		return {
			userId,
			honeycrisp,
			state,
			[Symbol.dispose]() {
				state[Symbol.dispose]();
				honeycrisp[Symbol.dispose]();
			},
		};
	},
});

export type HoneycrispSignedIn = InferSignedIn<typeof session>;

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export const [getSignedInSession, setSignedInSession] =
	createContext<HoneycrispSignedIn>();
