import { type AuthIdentity, requireSignedIn } from '@epicenter/auth';
import { createSession } from '@epicenter/svelte';
import { getOrCreateInstallationId } from '@epicenter/workspace';
import { createContext } from 'svelte';
import { openFuji } from '../routes/(signed-in)/fuji/browser';
import type { Entry, EntryId } from '../routes/(signed-in)/fuji/workspace';
import { auth } from './auth';

function buildFujiSignedIn(identity: AuthIdentity) {
	const userId = identity.user.id;
	const fuji = openFuji({
		userId,
		peer: {
			id: getOrCreateInstallationId(localStorage),
			name: 'Fuji',
			platform: 'web',
		},
		bearerToken: () => auth.bearerToken,
		encryptionKeys: () => requireSignedIn(auth).encryptionKeys,
	});
	return {
		userId,
		fuji,
		[Symbol.dispose]() {
			fuji[Symbol.dispose]();
		},
	};
}

export type FujiSignedIn = ReturnType<typeof buildFujiSignedIn>;

type FujiSignedInSession = FujiSignedIn & {
	entries: {
		get: (id: EntryId) => Entry | undefined;
		active: Entry[];
		deleted: Entry[];
	};
};

export const session = createSession({ auth, build: buildFujiSignedIn });

if (import.meta.hot) {
	import.meta.hot.dispose(() => session[Symbol.dispose]());
}

export const [getSignedInSession, setSignedInSession] =
	createContext<FujiSignedInSession>();
