import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { auth } from './auth';
import { openHoneycrisp } from '../routes/(signed-in)/honeycrisp/browser';

function buildHoneycrispSignedIn(identity: AuthIdentity) {
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
}

export type HoneycrispSignedIn = ReturnType<typeof buildHoneycrispSignedIn>;

export const session = createSession({ auth, build: buildHoneycrispSignedIn });

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export const [getSignedInSession, setSignedInSession] =
	createContext<HoneycrispSignedIn>();
